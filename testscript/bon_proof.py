"""
Proof: Base (single create + proxy verify) vs BoN (N parallel, first verified wins).
Runs ROUNDS of each and prints a head-to-head comparison.
"""

import asyncio
import os
import sys
import time
from uuid import uuid4

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from daytona import AsyncDaytona, AsyncSandbox, CreateSandboxFromSnapshotParams, DaytonaConflictError, DaytonaConfig

from getgather.browsers.daytona_browsers import (
    ProxyVerificationError,
    _configure_remote_sandbox,  # pyright: ignore[reportPrivateUsage]
)
from getgather.browsers.residential_proxy import get_proxy_config
from getgather.config import settings

API_KEY = "dtn_d90b20e10854f2b8f8c1de5b14b6991efe64a2f389f5289310c28d42c613329b"
SNAPSHOT = "chrome-live-daytona"
ORIGIN_IP = "45.131.194.160"
N = 3
ROUNDS = 5


async def make_sandbox(client: AsyncDaytona, label: str) -> AsyncSandbox:
    name = f"bon-proof-{uuid4().hex[:8]}"
    params = CreateSandboxFromSnapshotParams(
        snapshot=SNAPSHOT,
        name=name,
        labels={"fleet": "1", "bon_proof": "1"},
        public=False,
        auto_stop_interval=5,
        auto_delete_interval=10,
    )
    sandbox = await client.create(params, timeout=400)
    if sandbox.state != "started":
        await sandbox.start()
    return sandbox


async def delete_safe(sandbox: AsyncSandbox, retries: int = 5) -> None:
    for attempt in range(retries):
        try:
            await sandbox.delete()
            return
        except DaytonaConflictError:
            if attempt < retries - 1:
                await asyncio.sleep(3)
        except Exception:
            return


async def run_base(client: AsyncDaytona, round_n: int) -> float:
    t0 = time.perf_counter()
    sandbox = await make_sandbox(client, f"base-r{round_n}")
    try:
        await _configure_remote_sandbox(sandbox, f"base-{round_n}", ORIGIN_IP, None)
        elapsed = time.perf_counter() - t0
        print(f"  Base  round {round_n}: {elapsed:.1f}s ✓ ({sandbox.name})")
        return elapsed
    except ProxyVerificationError as e:
        elapsed = time.perf_counter() - t0
        print(f"  Base  round {round_n}: {elapsed:.1f}s ✗ proxy fail ({sandbox.name}): {e}")
        return elapsed
    finally:
        asyncio.create_task(delete_safe(sandbox))


async def run_bon(client: AsyncDaytona, round_n: int) -> float:
    handles: list[AsyncSandbox] = []
    winner_result: list[tuple[float, AsyncSandbox]] = []

    async def candidate(i: int) -> AsyncSandbox:
        sandbox = await make_sandbox(client, f"bon-r{round_n}-c{i}")
        handles.append(sandbox)
        await _configure_remote_sandbox(sandbox, f"bon-{round_n}-{i}", ORIGIN_IP, None)
        return sandbox

    t0 = time.perf_counter()
    tasks: set[asyncio.Task[AsyncSandbox]] = {
        asyncio.create_task(candidate(i)) for i in range(N)
    }
    pending = set(tasks)
    winner: AsyncSandbox | None = None

    while pending and winner is None:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if not task.cancelled() and task.exception() is None:
                winner = task.result()
                elapsed = time.perf_counter() - t0
                winner_result.append((elapsed, winner))
                for t in pending:
                    t.cancel()
                break

    elapsed = winner_result[0][0] if winner_result else time.perf_counter() - t0
    winner_name = winner.name if winner else "none"
    losers = [s for s in handles if s.name != winner_name]
    print(
        f"  BoN   round {round_n}: {elapsed:.1f}s ✓ winner={winner_name} "
        f"losers={[s.name for s in losers]}"
    )

    for s in losers:
        asyncio.create_task(delete_safe(s))

    return elapsed


async def main() -> None:
    client = AsyncDaytona(DaytonaConfig(api_key=API_KEY))

    proxy_config = await get_proxy_config(ORIGIN_IP, None, settings)
    if not proxy_config:
        print("ERROR: no proxy configured — enable proxy in .env first")
        await client.close()
        return

    print(f"Proxy: {proxy_config.get_proxy_url('test')[:60]}...")
    print(f"N={N}  ROUNDS={ROUNDS}\n")

    base_times: list[float] = []
    bon_times: list[float] = []

    for r in range(1, ROUNDS + 1):
        print(f"--- Round {r} ---")
        base_times.append(await run_base(client, r))
        await asyncio.sleep(3)
        bon_times.append(await run_bon(client, r))
        await asyncio.sleep(3)

    print(f"\n{'='*55}")
    print(f"{'Round':<8} {'Base':>8} {'BoN':>8} {'Diff':>10} {'Winner'}")
    print(f"{'-'*55}")
    for i, (b, n_) in enumerate(zip(base_times, bon_times), 1):
        diff = b - n_
        winner = "BoN" if diff > 0 else "Base"
        print(f"{i:<8} {b:>7.1f}s {n_:>7.1f}s {diff:>+9.1f}s  {winner}")
    print(f"{'-'*55}")
    avg_base = sum(base_times) / len(base_times)
    avg_bon = sum(bon_times) / len(bon_times)
    avg_diff = avg_base - avg_bon
    print(f"{'Avg':<8} {avg_base:>7.1f}s {avg_bon:>7.1f}s {avg_diff:>+9.1f}s  {'BoN' if avg_diff > 0 else 'Base'}")

    await client.close()


asyncio.run(main())
