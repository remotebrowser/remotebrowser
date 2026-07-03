"""
Proof: 5 concurrent users hitting Base vs BoN simultaneously.
More realistic — simulates real load where multiple requests race Daytona at once.
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
CONCURRENT_USERS = 5


async def make_sandbox(client: AsyncDaytona) -> AsyncSandbox:
    name = f"bon-par-{uuid4().hex[:8]}"
    params = CreateSandboxFromSnapshotParams(
        snapshot=SNAPSHOT,
        name=name,
        labels={"fleet": "1", "bon_parallel": "1"},
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


async def one_base(client: AsyncDaytona, user: int) -> float:
    t0 = time.perf_counter()
    try:
        sandbox = await make_sandbox(client)
        try:
            await _configure_remote_sandbox(sandbox, f"base-u{user}", ORIGIN_IP, None)
        except ProxyVerificationError:
            pass
        elapsed = time.perf_counter() - t0
        print(f"  Base  user {user}: {elapsed:.1f}s ✓")
        asyncio.create_task(delete_safe(sandbox))
        return elapsed
    except Exception as e:
        elapsed = time.perf_counter() - t0
        print(f"  Base  user {user}: {elapsed:.1f}s ✗ {type(e).__name__}")
        return elapsed


async def one_bon(client: AsyncDaytona, user: int) -> float:
    handles: list[AsyncSandbox] = []
    winner: AsyncSandbox | None = None

    async def candidate(i: int) -> AsyncSandbox:
        sb = await make_sandbox(client)
        handles.append(sb)
        await _configure_remote_sandbox(sb, f"bon-u{user}-c{i}", ORIGIN_IP, None)
        return sb

    t0 = time.perf_counter()
    tasks: set[asyncio.Task[AsyncSandbox]] = {
        asyncio.create_task(candidate(i)) for i in range(N)
    }
    pending = set(tasks)

    while pending and winner is None:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if not task.cancelled() and task.exception() is None:
                winner = task.result()
                for t in pending:
                    t.cancel()
                break

    elapsed = time.perf_counter() - t0
    if winner:
        print(f"  BoN   user {user}: {elapsed:.1f}s ✓ winner={winner.name}")
        losers = [s for s in handles if s.name != winner.name]
        for s in losers:
            asyncio.create_task(delete_safe(s))
    else:
        print(f"  BoN   user {user}: {elapsed:.1f}s ✗ all failed")

    return elapsed


async def run_batch(label: str, fn: type, client: AsyncDaytona) -> list[float]:
    print(f"\n=== {label}: {CONCURRENT_USERS} users simultaneously ===")
    t_wall = time.perf_counter()
    times = await asyncio.gather(*[fn(client, i + 1) for i in range(CONCURRENT_USERS)])
    wall = time.perf_counter() - t_wall
    print(f"  → wall clock (all done): {wall:.1f}s")
    return list(times)


async def main() -> None:
    client = AsyncDaytona(DaytonaConfig(api_key=API_KEY))

    proxy_config = await get_proxy_config(ORIGIN_IP, None, settings)
    if not proxy_config:
        print("ERROR: no proxy configured")
        await client.close()
        return

    print(f"N={N}  CONCURRENT_USERS={CONCURRENT_USERS}\n")

    base_times = await run_batch("BASE", one_base, client)  # type: ignore[arg-type]
    await asyncio.sleep(5)
    bon_times = await run_batch("BON", one_bon, client)  # type: ignore[arg-type]

    print(f"\n{'='*55}")
    print(f"{'User':<8} {'Base':>8} {'BoN':>8} {'Diff':>10} {'Winner'}")
    print(f"{'-'*55}")
    for i, (b, n_) in enumerate(zip(base_times, bon_times), 1):
        diff = b - n_
        print(f"{i:<8} {b:>7.1f}s {n_:>7.1f}s {diff:>+9.1f}s  {'BoN' if diff > 0 else 'Base'}")
    print(f"{'-'*55}")
    avg_b = sum(base_times) / len(base_times)
    avg_n = sum(bon_times) / len(bon_times)
    print(f"{'Avg':<8} {avg_b:>7.1f}s {avg_n:>7.1f}s {avg_b - avg_n:>+9.1f}s  {'BoN' if avg_b > avg_n else 'Base'}")
    print(f"{'Max':<8} {max(base_times):>7.1f}s {max(bon_times):>7.1f}s {'← p99 proxy variance impact'}")

    await client.close()


asyncio.run(main())
