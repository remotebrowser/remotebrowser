"""Daytona API timing breakdown: create(), start(), and returned state."""

import asyncio
import time
from uuid import uuid4

from daytona import AsyncDaytona, CreateSandboxFromSnapshotParams, DaytonaConfig

API_KEY = "dtn_d90b20e10854f2b8f8c1de5b14b6991efe64a2f389f5289310c28d42c613329b"
SNAPSHOT = "chrome-live-daytona"
RUNS = 3


async def measure_one(client: AsyncDaytona, run: int) -> None:
    name = f"timing-test-{uuid4().hex[:8]}"
    params = CreateSandboxFromSnapshotParams(
        snapshot=SNAPSHOT,
        name=name,
        labels={"fleet": "1", "timing_test": "1"},
        public=False,
        auto_stop_interval=5,
        auto_delete_interval=10,
    )

    print(f"\n--- Run {run} ({name}) ---")

    t0 = time.perf_counter()
    sandbox = await client.create(params, timeout=400)
    t_create = time.perf_counter() - t0
    print(f"create()  : {t_create:.2f}s  state={sandbox.state!r}")

    if sandbox.state != "started":
        t1 = time.perf_counter()
        await sandbox.start()
        t_start = time.perf_counter() - t1
        print(f"start()   : {t_start:.2f}s  state={sandbox.state!r}")
    else:
        t_start = 0.0
        print(f"start()   : skipped (already started)")

    print(f"total     : {t_create + t_start:.2f}s")

    t2 = time.perf_counter()
    await sandbox.delete()
    t_delete = time.perf_counter() - t2
    print(f"delete()  : {t_delete:.2f}s")


async def main() -> None:
    client = AsyncDaytona(DaytonaConfig(api_key=API_KEY))
    print(f"Running {RUNS} timing measurements against Daytona API...")
    for i in range(1, RUNS + 1):
        await measure_one(client, i)
    await client.close()


asyncio.run(main())
