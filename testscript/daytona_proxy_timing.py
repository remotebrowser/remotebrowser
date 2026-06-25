"""Daytona timing with proxy config + IP verification. Tests single vs N=3 parallel."""

import asyncio
import os
import sys
import time
from uuid import uuid4

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from daytona import AsyncDaytona, AsyncSandbox, CreateSandboxFromSnapshotParams, DaytonaConfig

from getgather.browsers.daytona_browsers import (
    _configure_sandbox_proxy,  # pyright: ignore[reportPrivateUsage]
    _get_sandbox_public_ip,  # pyright: ignore[reportPrivateUsage]
)
from getgather.browsers.residential_proxy import get_proxy_config
from getgather.config import settings

API_KEY = "dtn_d90b20e10854f2b8f8c1de5b14b6991efe64a2f389f5289310c28d42c613329b"
SNAPSHOT = "chrome-live-daytona"
ORIGIN_IP = "45.131.194.160"
BROWSER_ID = "timing-test"


async def run_full_chain(client: AsyncDaytona, label: str) -> tuple[str, dict[str, float]]:
    name = f"timing-{uuid4().hex[:8]}"
    params = CreateSandboxFromSnapshotParams(
        snapshot=SNAPSHOT,
        name=name,
        labels={"fleet": "1", "timing_test": "1"},
        public=False,
        auto_stop_interval=5,
        auto_delete_interval=10,
    )

    timings: dict[str, float] = {}

    t = time.perf_counter()
    sandbox = await client.create(params, timeout=400)
    timings["create"] = time.perf_counter() - t
    state_after_create = sandbox.state

    if sandbox.state != "started":
        t = time.perf_counter()
        await sandbox.start()
        timings["start"] = time.perf_counter() - t
    else:
        timings["start"] = 0.0

    # proxy config
    proxy_config = await get_proxy_config(ORIGIN_IP, None, settings)
    proxy_url = proxy_config.get_proxy_url(BROWSER_ID) if proxy_config else None

    if proxy_url:
        t = time.perf_counter()
        ip_before = await _get_sandbox_public_ip(sandbox)
        timings["ip_before"] = time.perf_counter() - t

        t = time.perf_counter()
        _ = await _configure_sandbox_proxy(sandbox, proxy_url)
        timings["proxy_config"] = time.perf_counter() - t

        t = time.perf_counter()
        ip_after = await _get_sandbox_public_ip(sandbox)
        timings["ip_after"] = time.perf_counter() - t

        ip_changed = ip_before != ip_after if (ip_before and ip_after) else None
        timings["total"] = sum(timings.values())
        print(
            f"  {label} ({name}): create={timings['create']:.1f}s state={state_after_create!r} "
            f"ip_before={timings['ip_before']:.1f}s proxy_cfg={timings['proxy_config']:.1f}s "
            f"ip_after={timings['ip_after']:.1f}s ip_changed={ip_changed} "
            f"TOTAL={timings['total']:.1f}s"
        )
    else:
        timings["total"] = timings["create"] + timings["start"]
        print(f"  {label} ({name}): create={timings['create']:.1f}s  (no proxy configured)")

    return name, timings


async def test_single(client: AsyncDaytona) -> float:
    print("\n=== SINGLE (base behavior) ===")
    t0 = time.perf_counter()
    name, _ = await run_full_chain(client, "single")
    wall = time.perf_counter() - t0
    print(f"  wall time: {wall:.1f}s")

    # cleanup
    async for sb in client.list():
        if sb.name == name:
            await sb.delete()
            break
    return wall


async def test_best_of_n(client: AsyncDaytona, n: int = 3) -> float:
    print(f"\n=== BEST-OF-{n} (parallel) ===")
    winner_time: list[float] = []
    handles: list[AsyncSandbox] = []

    async def candidate(i: int) -> tuple[str, dict[str, float]]:
        name, timings = await run_full_chain(client, f"cand-{i}")
        handles.append(name)  # type: ignore[arg-type]
        return name, timings

    t0 = time.perf_counter()
    tasks: set[asyncio.Task[tuple[str, dict[str, float]]]] = {
        asyncio.create_task(candidate(i)) for i in range(n)
    }
    winner_name = ""
    pending = set(tasks)
    while pending and not winner_time:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if not task.cancelled() and task.exception() is None:
                winner_name, _ = task.result()
                winner_time.append(time.perf_counter() - t0)
                for t in pending:
                    t.cancel()
                break

    wall = winner_time[0] if winner_time else -1.0
    print(f"  winner: {winner_name}  wall time: {wall:.1f}s")

    # cleanup all
    async for sb in client.list():
        if sb.labels and sb.labels.get("timing_test") == "1":
            try:
                await sb.delete()
            except Exception:
                pass
    return wall


async def main() -> None:
    client = AsyncDaytona(DaytonaConfig(api_key=API_KEY))

    proxy_config = await get_proxy_config(ORIGIN_IP, None, settings)
    print(f"Proxy enabled: {proxy_config is not None}")
    if proxy_config:
        print(f"Proxy URL (sample): {proxy_config.get_proxy_url(BROWSER_ID)}")

    single_times: list[float] = []
    bon_times: list[float] = []

    ROUNDS = 3
    for r in range(1, ROUNDS + 1):
        print(f"\n{'=' * 50} ROUND {r} {'=' * 50}")
        single_times.append(await test_single(client))
        await asyncio.sleep(2)
        bon_times.append(await test_best_of_n(client, n=3))

    print(f"\n{'=' * 50} SUMMARY {'=' * 50}")
    for i, (s, b) in enumerate(zip(single_times, bon_times), 1):
        diff = s - b
        print(
            f"  Round {i}: single={s:.1f}s  BoN={b:.1f}s  diff={diff:+.1f}s ({'BoN faster' if diff > 0 else 'base faster'})"
        )
    print(
        f"  Avg: single={sum(single_times) / len(single_times):.1f}s  BoN={sum(bon_times) / len(bon_times):.1f}s"
    )

    await client.close()


asyncio.run(main())
