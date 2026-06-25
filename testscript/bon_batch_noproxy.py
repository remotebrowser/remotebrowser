"""Same as bon_batch.py but skips proxy config entirely — measures pure Daytona create speed."""

import asyncio
import os
import sys
import time
from uuid import uuid4

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from daytona import AsyncDaytona, AsyncSandbox, CreateSandboxFromSnapshotParams, DaytonaConflictError, DaytonaConfig

API_KEY = "dtn_d90b20e10854f2b8f8c1de5b14b6991efe64a2f389f5289310c28d42c613329b"
SNAPSHOT = "chrome-live-daytona"
N = 3
CONCURRENT_USERS = 5


async def make_sandbox(client: AsyncDaytona, tag: str) -> AsyncSandbox:
    name = f"{tag}-{uuid4().hex[:8]}"
    params = CreateSandboxFromSnapshotParams(
        snapshot=SNAPSHOT,
        name=name,
        labels={"fleet": "1", "batch_test": "1"},
        public=False,
        auto_stop_interval=5,
        auto_delete_interval=10,
    )
    sb = await client.create(params, timeout=400)
    if sb.state != "started":
        await sb.start()
    return sb


async def delete_safe(sb: AsyncSandbox) -> None:
    for attempt in range(5):
        try:
            await sb.delete()
            return
        except DaytonaConflictError:
            if attempt < 4:
                await asyncio.sleep(3)
        except Exception:
            return


async def one_base(client: AsyncDaytona, user: int) -> float:
    t0 = time.perf_counter()
    try:
        sb = await make_sandbox(client, "base")
        elapsed = time.perf_counter() - t0
        print(f"  base user {user}: {elapsed:.1f}s ✓  ({sb.name})", flush=True)
        asyncio.create_task(delete_safe(sb))
        return elapsed
    except Exception as e:
        elapsed = time.perf_counter() - t0
        print(f"  base user {user}: {elapsed:.1f}s ✗ {type(e).__name__}", flush=True)
        return elapsed


async def one_bon(client: AsyncDaytona, user: int) -> float:
    handles: list[AsyncSandbox] = []
    winner: AsyncSandbox | None = None

    async def candidate(i: int) -> AsyncSandbox:
        sb = await make_sandbox(client, "bon")
        handles.append(sb)
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
    status = "✓" if winner else "✗"
    winner_name = winner.name if winner else "none"
    print(f"  bon  user {user}: {elapsed:.1f}s {status}  winner={winner_name}", flush=True)
    for s in handles:
        if not winner or s.name != winner.name:
            asyncio.create_task(delete_safe(s))
    return elapsed


async def main(mode: str) -> None:
    client = AsyncDaytona(DaytonaConfig(api_key=API_KEY))
    fn = one_base if mode == "base" else one_bon
    tag = "BASE" if mode == "base" else f"BON (N={N})"
    print(f"[{tag}] {CONCURRENT_USERS} users — no proxy, pure Daytona create speed", flush=True)

    t_wall = time.perf_counter()
    times: list[float] = list(
        await asyncio.gather(*[fn(client, i + 1) for i in range(CONCURRENT_USERS)])
    )
    wall = time.perf_counter() - t_wall
    avg = sum(times) / len(times)
    print(f"[{tag}] avg={avg:.1f}s  max={max(times):.1f}s  wall={wall:.1f}s")
    await client.close()


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "base"
    asyncio.run(main(mode))
