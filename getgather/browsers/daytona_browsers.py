import asyncio
import random
import time
from collections.abc import AsyncIterator
from typing import Any

from daytona import (
    AsyncDaytona,
    AsyncSandbox,
    CreateSandboxFromSnapshotParams,
    DaytonaConfig,
    DaytonaConflictError,
    DaytonaNotFoundError,
    ListSandboxesQuery,
)
from loguru import logger
from nanoid import generate

from getgather.browsers.backend import BROWSER_NAME_PREFIX, BrowserNotFound
from getgather.browsers.residential_proxy import default_proxy_config, get_proxy_config
from getgather.config import settings


class ProxyVerificationError(Exception):
    """Raised when egress IP is unchanged after proxy configuration."""


CDP_PORT = 9222
VNC_PORT = 8080

# Chrome stores last_visit_time as microseconds since 1601-01-01; this offset converts to unix epoch.
CHROMIUM_EPOCH_OFFSET_SECONDS = 11644473600
CHROME_HISTORY_PATH = "/home/user/chrome-profile/Default/History"

# Daytona auto-stops a sandbox after this many idle minutes (no sandbox event), parking it at
# $0 compute. Once it has been continuously stopped for TTL_MINUTES, Daytona's native
# auto_delete_interval (set at create time) deletes it.
AUTO_STOP_MINUTES = 15
TTL_MINUTES = 60

# CDP is reached over a Daytona signed preview URL: a self-authenticating HTTPS reverse proxy to
# the sandbox's port 9222 (https://9222-<token>.<proxy-domain>).
#
# SECURITY: this URL is PUBLICLY reachable on the internet. The sandbox is created public=False,
# but a signed preview URL bypasses that — the only credential is the token embedded in the URL
# itself, so anyone who obtains the cdp_url can drive the browser's CDP until the token expires.
# Treat cdp_url as a bearer secret. The token is stateless and survives sandbox restarts.
SIGNED_URL_TTL_SECONDS = 3600

# An open live-view iframe streams noVNC over port 8080, which Daytona counts as sandbox activity
# and uses to reset auto_stop_interval. The dashboard embeds a live view per browser, so without a
# gate just viewing it would keep every sandbox alive indefinitely (defeating auto-stop). Only hand
# out the live URL when the browser has had real Chrome activity within this window; otherwise let
# the idle sandbox auto-stop. A sandbox with no history yet (e.g. a fresh sign-in) is treated as
# active so the primary "watch the sign-in" flow keeps working.
LIVE_VIEW_MAX_IDLE_SECONDS = 3600

LABEL_FLEET = "fleet"
# A spare carries pool=spare. On claim the labels are replaced with claimed_as=<requested id>, which
# (a) removes it from the spare list and (b) records the requested incognito id -> this sandbox
# binding IN Daytona, so resolution is stateless: no in-memory map, survives restarts. The requested
# id is unique per request, so the binding is unambiguous. Teardown (15m auto-stop / 60m auto-delete)
# applies unchanged once it is no longer a spare.
LABEL_POOL = "pool"
POOL_SPARE = "spare"
LABEL_CLAIMED = "claimed_as"
# Records that a residential proxy is configured, and which (provider, country). A claim whose
# resolved proxy matches reuses it as-is — letting a pool spare be pre-proxied at spawn so the slow
# setup + IP-verify never lands on the request's hot path. A mismatch reconfigures.
LABEL_PROXIED = "proxied"
LABEL_PROXY_TYPE = "proxy_type"
LABEL_PROXY_CC = "proxy_cc"

FLEET_LABELS = {LABEL_FLEET: "1"}
SPARE_LABELS = {LABEL_FLEET: "1", LABEL_POOL: POOL_SPARE}

# Pool spares get a self-describing `spare-<rand>` name so an unclaimed pool sandbox is obvious in
# the Daytona dashboard. The name is only used internally (resolved via the claimed_as label), so it
# does not need the incognito prefix.
SPARE_NAME_PREFIX = "spare-"
_SPARE_ID_CHARS = "23456789abcdefghijkmnpqrstuvwxyz"

# Incognito (ephemeral) browser ids carry this prefix (minted by dpage). The pool only serves
# incognito requests, so the claim path keys off it. Must match the prefix dpage uses.
INCOGNITO_PREFIX = "E"


def _sandbox_name(browser_id: str) -> str:
    return f"{BROWSER_NAME_PREFIX}{browser_id}"


async def _configure_sandbox_proxy(sandbox: AsyncSandbox, proxy_url: str) -> bool:
    stripped = proxy_url.removeprefix("http://")
    cmds = [
        "sed -i '/^Upstream http/d' /app/tinyproxy.conf",
        f"sed -i '$ a\\Upstream http {stripped}' /app/tinyproxy.conf",
        "sudo /command/s6-svc -r /run/service/tinyproxy",
        "while ! curl -s -o /dev/null -x http://localhost:8119 http://tinyproxy.stats; do sleep 0.1; done",
    ]
    for cmd in cmds:
        try:
            response = await sandbox.process.exec(cmd)
        except Exception as e:
            logger.warning(f"Proxy config failed on {sandbox.name}: {type(e).__name__}: {e}")
            return False
        if response.exit_code != 0:
            logger.warning(
                f"Proxy config exit={response.exit_code} on {sandbox.name}: cmd={cmd!r} stderr={response.result!r}"
            )
            return False
    return True


async def _get_sandbox_public_ip(
    sandbox: AsyncSandbox, *, retries: int = 5, retry_delay: float = 2.0
) -> str | None:
    cmd = "curl -s --max-time 10 --proxy http://127.0.0.1:8119 https://ip.fly.dev"
    for attempt in range(1, retries + 1):
        try:
            response = await sandbox.process.exec(cmd)
            ip = response.result.strip() if response.exit_code == 0 else ""
            if ip:
                return ip
        except Exception as e:
            logger.debug(f"IP check {attempt}/{retries} on {sandbox.name} failed: {e}")
        if attempt < retries:
            await asyncio.sleep(retry_delay)
    logger.warning(f"IP check on {sandbox.name} failed after {retries} attempts")
    return None


async def _apply_and_verify_proxy(sandbox: AsyncSandbox, proxy_url: str) -> None:
    """Point tinyproxy at the upstream and verify the egress IP actually changed."""
    _t0 = time.monotonic()  # [TIMING] temporary
    ip_before = await _get_sandbox_public_ip(sandbox)
    _t_before = time.monotonic()  # [TIMING] temporary
    logger.debug(f"Sandbox {sandbox.name} IP before proxy: {ip_before}")

    ok = await _configure_sandbox_proxy(sandbox, proxy_url)
    _t_cfg = time.monotonic()  # [TIMING] temporary
    if not ok:
        return

    ip_after = await _get_sandbox_public_ip(sandbox)
    logger.info(  # [TIMING] temporary
        f"[TIMING] proxy {sandbox.name}: ip_before={_t_before - _t0:.1f}s "
        f"configure={_t_cfg - _t_before:.1f}s ip_after={time.monotonic() - _t_cfg:.1f}s"
    )
    if ip_before and ip_after and ip_before != ip_after:
        logger.info(f"Sandbox {sandbox.name} IP changed: {ip_before} -> {ip_after}")
    elif ip_before == ip_after:
        raise ProxyVerificationError(
            f"Sandbox {sandbox.name} IP unchanged after proxy: {ip_before}"
        )


def _browser_id_from_name(name: str) -> str:
    return name.removeprefix(BROWSER_NAME_PREFIX)


class DaytonaBackend:
    """Launch a Daytona sandbox per browser, optionally serving incognito requests from a warm pool.

    The browser_id -> sandbox mapping is the deterministic sandbox name plus labels (incognito ids
    that claimed a pool spare are bound via a claimed_as label), so there is no in-process state and
    resolution survives restarts. CDP is reached over a Daytona signed preview URL: a public, internet-reachable,
    self-authenticating HTTPS reverse proxy to port 9222 (no inbound networking into the sandbox is
    required). Live view embeds the snapshot's built-in noVNC on port 8080 via a signed preview URL.
    Residential proxy/geo-IP are supported via tinyproxy (preconfigured in the snapshot, same as podman).

    Sandbox teardown is owned by Daytona: auto_stop_interval stops idle sandboxes and
    auto_delete_interval deletes them once continuously stopped past the TTL (both set at create
    time in _create).
    """

    def __init__(self, api_key: str, api_url: str, snapshot: str) -> None:
        self.snapshot = snapshot
        self.client = AsyncDaytona(DaytonaConfig(api_key=api_key, api_url=api_url or None))
        self._locks: dict[str, asyncio.Lock] = {}
        self._pool_size = settings.DAYTONA_INCOGNITO_POOL_SIZE
        # Pool inventory and the claimed-id binding both live in Daytona labels (see LABEL_CLAIMED),
        # so the backend holds no durable state and survives restarts. Claims are NOT serialized:
        # concurrent claimers race optimistically and _try_claim's confirm step resolves collisions,
        # so requests don't queue behind one lock (cross-instance races self-heal the same way).
        # Collapses concurrent reconcile calls into one; separate so a slow backfill (each spawn
        # cold-boots a sandbox, ~9s) never blocks anything else.
        self._reconcile_lock = asyncio.Lock()
        # Strong refs to background reconcile tasks; asyncio only holds weak refs, so an unreferenced
        # task can be garbage-collected mid-flight (and the pool would never fill).
        self._bg_tasks: set[asyncio.Task[None]] = set()

    def _spawn_reconcile(self) -> None:
        task = asyncio.create_task(self._reconcile_pool())
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    def _pool_eligible(self, browser_id: str) -> bool:
        """A non-empty pool only ever serves incognito ids; everything else cold-creates."""
        return self._pool_size > 0 and browser_id.startswith(INCOGNITO_PREFIX)

    async def _iter_sandboxes(
        self, labels: dict[str, str], *, started_only: bool = False
    ) -> AsyncIterator[AsyncSandbox]:
        """Yield our sandboxes matching `labels`, skipping non-fleet names (e.g. a just-deleted
        `DESTROYED_<name>_<ts>`) and, when asked, anything Daytona has auto-stopped."""
        async for sandbox in self.client.list(ListSandboxesQuery(labels=labels)):
            if not (sandbox.name and sandbox.name.startswith(BROWSER_NAME_PREFIX)):
                continue
            if started_only and sandbox.state != "started":
                continue
            yield sandbox

    async def _ensure_proxy(
        self,
        sandbox: AsyncSandbox,
        browser_id: str,
        origin_ip: str | None,
        target_domain: str | None,
    ) -> None:
        """Configure the residential proxy for this request, reusing a pre-applied one when it matches.

        A pool spare is pre-proxied at spawn with the default (provider, country). If the request
        resolves to the same pair, the proxy is already correct and we skip the slow setup + IP-verify
        entirely — the whole point of pre-warming. Otherwise (different provider/country, or never
        proxied) we (re)configure and re-tag.
        """
        proxy_config = await get_proxy_config(origin_ip, target_domain, settings)
        if proxy_config is None:
            return  # no proxy desired (no origin ip / MaxMind off)
        desired_type = proxy_config.type_
        desired_cc = proxy_config.location.country or ""

        labels = sandbox.labels or {}
        if (
            labels.get(LABEL_PROXIED) == "1"
            and labels.get(LABEL_PROXY_TYPE) == desired_type
            and labels.get(LABEL_PROXY_CC) == desired_cc
        ):
            logger.info(  # [TIMING] temporary
                f"[TIMING] proxy SKIP {sandbox.name}: pre-applied {desired_type}/{desired_cc} reused"
            )
            return  # pre-applied proxy already matches this request

        logger.info(  # [TIMING] temporary
            f"[TIMING] proxy RECONFIGURE {sandbox.name}: want {desired_type}/{desired_cc}, "
            f"had {labels.get(LABEL_PROXY_TYPE)}/{labels.get(LABEL_PROXY_CC)}"
        )
        try:
            await _apply_and_verify_proxy(sandbox, proxy_config.get_proxy_url(browser_id))
        except ProxyVerificationError as e:
            logger.warning(str(e))
        await self._mark_proxied(sandbox, desired_type, desired_cc)

    async def _mark_proxied(self, sandbox: AsyncSandbox, proxy_type: str, country: str) -> None:
        # Mark proxied even if verification was inconclusive — a retry yields the same upstream IP.
        try:
            await sandbox.set_labels({
                **(sandbox.labels or {}),
                LABEL_PROXIED: "1",
                LABEL_PROXY_TYPE: proxy_type,
                LABEL_PROXY_CC: country,
            })
        except Exception as e:
            logger.warning(f"Failed to mark {sandbox.name} proxied: {e}")

    async def _resolve(self, browser_id: str) -> str:
        """Resolve a requested browser_id to the real sandbox id backing it.

        Incognito ids may have claimed a pool spare whose sandbox keeps its own (immutable) name; the
        binding is recorded as a claimed_as=<browser_id> label. Per-user ids, unclaimed ids, and
        cold-created incognito ids resolve to themselves. One Daytona lookup for incognito, none else.
        """
        if not self._pool_eligible(browser_id):
            return browser_id
        async for sandbox in self._iter_sandboxes({LABEL_CLAIMED: browser_id}):
            return _browser_id_from_name(sandbox.name)
        return browser_id

    async def startup(self) -> None:
        if self._pool_size <= 0:
            return
        # Adopt spares that survived a restart, then backfill — both in the background so server
        # startup is never blocked on Daytona.
        self._spawn_reconcile()

    async def shutdown(self) -> None:
        await self.client.close()

    async def create_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]:
        t0 = time.monotonic()  # [TIMING] temporary
        effective_id = await self._claim_spare_for(browser_id)
        t_claim = time.monotonic()  # [TIMING] temporary
        lock = self._locks.setdefault(effective_id, asyncio.Lock())
        async with lock:
            sandbox = await self._ensure(effective_id)
            t_ensure = time.monotonic()  # [TIMING] temporary
            await self._ensure_proxy(sandbox, effective_id, origin_ip, target_domain)
            t_proxy = time.monotonic()  # [TIMING] temporary
            info = await self._get_info(sandbox)
            logger.info(  # [TIMING] temporary
                f"[TIMING] create_browser {browser_id}: claim={t_claim - t0:.1f}s "
                f"ensure={t_ensure - t_claim:.1f}s proxy={t_proxy - t_ensure:.1f}s "
                f"info={time.monotonic() - t_proxy:.1f}s total={time.monotonic() - t0:.1f}s"
            )
            return info

    async def get_browser(
        self, browser_id: str, origin_ip: str | None, target_domain: str | None
    ) -> dict[str, Any]:
        effective_id = await self._resolve(browser_id)
        sandbox = await self._get(_sandbox_name(effective_id))
        if sandbox is None:
            raise BrowserNotFound(browser_id)
        if origin_ip:
            await self._ensure_proxy(sandbox, effective_id, origin_ip, target_domain)
        return await self._get_info(sandbox)

    async def delete_browser(self, browser_id: str) -> dict[str, Any]:
        effective_id = await self._resolve(browser_id)
        sandbox = await self._get(_sandbox_name(effective_id))
        self._locks.pop(effective_id, None)
        if sandbox is None:
            return {"status": "not found"}
        # Deleting the sandbox also removes its claimed_as label, so no binding is left behind.
        await sandbox.delete()
        return {"status": "deleted"}

    async def browser_exists(self, browser_id: str) -> bool:
        return await self._get(_sandbox_name(await self._resolve(browser_id))) is not None

    async def list_browser_ids(self) -> list[str]:
        return [
            _browser_id_from_name(sandbox.name)
            async for sandbox in self._iter_sandboxes(FLEET_LABELS)
        ]

    async def cleanup_idle(self) -> list[str]:
        # Teardown is owned by Daytona's native auto_stop_interval + auto_delete_interval (set in
        # _create). The only periodic work is keeping the warm pool topped up (spares that Daytona
        # auto-stopped after idle are dropped and respawned here).
        if self._pool_size > 0:
            await self._reconcile_pool()
        return []

    async def _claim_spare_for(self, browser_id: str) -> str:
        """For an incognito request, claim a ready spare and record the binding in a Daytona label.

        Returns the spare's id when one was claimed, else the original browser_id (cold-create
        path). Only incognito ids are eligible; per-user ids always cold-create under their own
        deterministic name. The lock serializes claims within this process.
        """
        if not self._pool_eligible(browser_id):
            return browser_id

        # Shuffle so concurrent claimers don't all target the same spare first (each collision costs
        # a wasted set_labels + retry). Claims run unserialized; _try_claim confirms exclusive ownership.
        _t_list0 = time.monotonic()  # [TIMING] temporary
        candidates = [sb async for sb in self._iter_sandboxes(SPARE_LABELS, started_only=True)]
        logger.info(  # [TIMING] temporary
            f"[TIMING] _claim_spare_for {browser_id}: list_spares={time.monotonic() - _t_list0:.1f}s "
            f"({len(candidates)} candidates)"
        )
        random.shuffle(candidates)
        for sb in candidates:
            if sb.name and await self._try_claim(sb.name, browser_id):
                spare_id = _browser_id_from_name(sb.name)
                logger.info(f"Claimed pooled spare {spare_id} for incognito browser {browser_id}")
                self._spawn_reconcile()
                return spare_id

        logger.info(f"Pool empty; cold-creating incognito browser {browser_id}")
        return browser_id

    async def _try_claim(self, name: str, browser_id: str) -> bool:
        """Claim one spare candidate, guarding against Daytona's eventually-consistent label list.

        The list query can return a sandbox that was already claimed or deleted seconds ago, so re-GET
        it (object reads are far more consistent than the label index): skip it unless it is still a
        live, unclaimed spare. After claiming, re-read once more to confirm the label stuck (lost a
        race otherwise). Returns True only when this caller now exclusively owns the sandbox.
        """
        _t0 = time.monotonic()  # [TIMING] temporary
        fresh = await self._get(name)
        _t_get = time.monotonic()  # [TIMING] temporary
        if fresh is None or fresh.state != "started":
            return False  # stale list entry — already deleted/stopped
        labels = fresh.labels or {}
        if labels.get(LABEL_POOL) != POOL_SPARE or LABEL_CLAIMED in labels:
            return False  # stale list entry — already claimed by someone else
        # Drop pool=spare (leaves the pool) and record the binding, but keep the rest — notably the
        # proxied/proxy_type/proxy_cc tags so the pre-applied proxy survives the claim.
        new_labels = {k: v for k, v in labels.items() if k != LABEL_POOL}
        new_labels[LABEL_FLEET] = "1"
        new_labels[LABEL_CLAIMED] = browser_id
        try:
            await fresh.set_labels(new_labels)
        except Exception as e:
            logger.warning(f"Failed to claim spare {name}: {e}")
            return False
        _t_set = time.monotonic()  # [TIMING] temporary
        confirmed = await self._get(name)
        logger.info(  # [TIMING] temporary
            f"[TIMING] _try_claim {name}: get={_t_get - _t0:.1f}s "
            f"set_labels={_t_set - _t_get:.1f}s confirm={time.monotonic() - _t_set:.1f}s"
        )
        if confirmed is None or (confirmed.labels or {}).get(LABEL_CLAIMED) != browser_id:
            logger.warning(f"Lost claim race for spare {name}; skipping")
            return False
        return True

    async def _reconcile_pool(self) -> None:
        """Backfill the pool to POOL_SIZE from Daytona's current spare count.

        Stateless: the spare count is read from Daytona labels, not memory. Idempotent and safe to
        call repeatedly; serialized under its own lock (not the claim lock) so the slow spawns never
        block a claim, while concurrent reconcile calls collapse into one.
        """
        async with self._reconcile_lock:
            spare_count = sum([
                1 async for _ in self._iter_sandboxes(SPARE_LABELS, started_only=True)
            ])
            deficit = self._pool_size - spare_count

            for _ in range(max(0, deficit)):
                try:
                    await self._spawn_spare()
                except Exception as e:
                    logger.warning(f"Failed to spawn pool spare: {type(e).__name__}: {e}")
                    break

    async def _spawn_spare(self) -> None:
        spare_id = SPARE_NAME_PREFIX + generate(_SPARE_ID_CHARS, 8)
        name = _sandbox_name(spare_id)
        logger.info(f"Spawning pool spare {name}")
        sandbox = await self._create(name, labels=SPARE_LABELS)
        # Pre-apply the default proxy now (off the hot path). A claim that resolves to the same
        # (provider, country) reuses it via the proxy_type/proxy_cc labels and skips proxy setup.
        # Session id is the spare's own id, which becomes the claimed browser's effective id.
        config = default_proxy_config(settings)
        if config is None:
            return
        try:
            await _apply_and_verify_proxy(sandbox, config.get_proxy_url(spare_id))
        except ProxyVerificationError as e:
            logger.warning(str(e))
        await self._mark_proxied(sandbox, config.type_, config.location.country or "")

    async def get_cdp_base_url(self, browser_id: str) -> str:
        sandbox = await self._get(_sandbox_name(await self._resolve(browser_id)))
        if sandbox is None:
            raise BrowserNotFound(browser_id)
        signed = await sandbox.create_signed_preview_url(
            CDP_PORT, expires_in_seconds=SIGNED_URL_TTL_SECONDS
        )
        return signed.url

    def cdp_websocket_base(self) -> None:
        # CDP is reached per-sandbox over a signed HTTPS preview URL via get_cdp_base_url +
        # /json/version, not a shared websocket proxy, so there is no relay base.
        return None

    async def get_vnc_endpoint(self, browser_id: str) -> tuple[str, int] | None:
        return None  # no raw VNC port; live view uses get_live_view_url (noVNC on VNC_PORT)

    async def get_live_view_url(self, browser_id: str) -> str | None:
        sandbox = await self._get(_sandbox_name(await self._resolve(browser_id)))
        if sandbox is None:
            raise BrowserNotFound(browser_id)
        if sandbox.state != "started":
            return None  # a stopped sandbox has nothing to show and must not be woken to watch it

        # Gate on recent activity so an embedded live view can't keep an idle sandbox alive. A
        # missing timestamp (no history yet / read error) is treated as active to avoid hiding the
        # live view for a fresh sign-in.
        last_activity = await self._get_last_activity(sandbox)
        if last_activity is not None:
            idle_seconds = time.time() - last_activity
            if idle_seconds > LIVE_VIEW_MAX_IDLE_SECONDS:
                logger.info(
                    f"Skipping live view for idle sandbox {sandbox.name}: "
                    f"last activity {idle_seconds:.0f}s ago (> {LIVE_VIEW_MAX_IDLE_SECONDS}s)"
                )
                return None

        signed = await sandbox.create_signed_preview_url(
            VNC_PORT, expires_in_seconds=SIGNED_URL_TTL_SECONDS
        )
        return signed.url

    async def _ensure(self, browser_id: str) -> AsyncSandbox:
        name = _sandbox_name(browser_id)
        _t0 = time.monotonic()  # [TIMING] temporary
        sandbox = await self._get(name)
        _t_get = time.monotonic()  # [TIMING] temporary
        created = False  # [TIMING] temporary
        if sandbox is None:
            sandbox = await self._create(name)
            created = True  # [TIMING] temporary
        _t_create = time.monotonic()  # [TIMING] temporary

        started = False  # [TIMING] temporary
        if sandbox.state != "started":
            logger.info(f"Starting Daytona sandbox {name} (state={sandbox.state})")
            await sandbox.start()
            started = True  # [TIMING] temporary
        logger.info(  # [TIMING] temporary
            f"[TIMING] _ensure {name}: get={_t_get - _t0:.1f}s "
            f"create={_t_create - _t_get:.1f}s(did={created}) "
            f"start={time.monotonic() - _t_create:.1f}s(did={started})"
        )
        return sandbox

    async def _get_info(self, sandbox: AsyncSandbox) -> dict[str, Any]:
        signed = await sandbox.create_signed_preview_url(
            CDP_PORT, expires_in_seconds=SIGNED_URL_TTL_SECONDS
        )
        # last_activity is intentionally not computed here: it cost ~1s (a `cp History + sqlite3`
        # exec that usually returns empty on a fresh browser) on the create/get hot path and nothing
        # consumes the field. The live-view idle gate reads it on demand via _get_last_activity.
        return {
            "hostname": sandbox.name,
            "cdp_url": signed.url,  # public, internet-reachable; bearer secret (see SIGNED_URL_TTL_SECONDS)
            "app_state": sandbox.state,
            "last_activity_timestamp": None,
        }

    async def _get_last_activity(self, sandbox: AsyncSandbox) -> float | None:
        """Most recent Chrome visit time as a unix timestamp, read from the browser history DB.

        Mirrors PodmanBackend's get_container_last_activity: copy the (Chrome-locked) History DB,
        then query it with sqlite3. Requires a running sandbox; returns None otherwise or on error.
        """
        if sandbox.state != "started":
            return None
        command = (
            f"cp {CHROME_HISTORY_PATH} /tmp/cf-history.db && "
            "sqlite3 /tmp/cf-history.db 'select MAX(last_visit_time) from urls;'"
        )
        try:
            response = await sandbox.process.exec(command)
        except Exception as e:
            logger.warning(
                f"Unexpected error fetching last activity for {sandbox.name}: {type(e).__name__}: {e}"
            )
            return None
        output = response.result.strip()
        if response.exit_code != 0 or not output:
            logger.warning(
                f"Failed to fetch last activity for {sandbox.name}: exit={response.exit_code} result={output!r}"
            )
            return None
        try:
            chromium_time = float(output)
        except ValueError:
            return None
        return (chromium_time / 1_000_000) - CHROMIUM_EPOCH_OFFSET_SECONDS

    async def _get(self, name: str) -> AsyncSandbox | None:
        try:
            return await self.client.get(name)
        except DaytonaNotFoundError:
            return None

    async def _create(self, name: str, labels: dict[str, str] | None = None) -> AsyncSandbox:
        params = CreateSandboxFromSnapshotParams(
            snapshot=self.snapshot,
            name=name,
            labels=labels or {LABEL_FLEET: "1"},
            public=False,
            auto_stop_interval=AUTO_STOP_MINUTES,
            # delete after TTL_MINUTES continuously stopped; Daytona owns teardown
            auto_delete_interval=TTL_MINUTES,
        )
        logger.info(f"Creating Daytona sandbox {name} from snapshot {self.snapshot}")
        try:
            return await self.client.create(params, timeout=400)
        except DaytonaConflictError:
            # Lost a concurrent create race (same deterministic name); adopt the winner.
            logger.info(f"Daytona sandbox {name} already exists, adopting")
            existing = await self._get(name)
            if existing is None:
                raise
            return existing
