import asyncio
import base64
import json
import shutil
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import zendriver as zd
import zendriver.cdp.page as cdp_page
from loguru import logger

from getgather.config import settings

_RECORDING_TIMEOUT = 5 * 60  # seconds
_SCREENCAST_FPS = 5
_SCREENCAST_NTH_FRAME = 2
_SCREENCAST_QUALITY = 75
_SCREENCAST_MAX_WIDTH = 854
_SCREENCAST_MAX_HEIGHT = 480


@dataclass
class RecordingMeta:
    recording_id: str
    signin_id: str
    browser_id: str
    started_at: str  # ISO 8601
    stopped_at: str | None
    duration_seconds: float | None
    storage_key: str  # relative path (local) or S3 key (s3)
    storage_backend: str  # "local" | "s3"


@dataclass
class _ActiveRecording:
    meta: RecordingMeta
    page: zd.Tab
    frames_dir: Path
    frame_count: int
    timeout_task: asyncio.Task[None]
    started_ts: float


_active: dict[str, _ActiveRecording] = {}


async def start_recording(signin_id: str, browser_id: str, page: zd.Tab) -> str:
    if signin_id in _active:
        logger.warning(f"Recording already active for {signin_id}, skipping")
        return _active[signin_id].meta.recording_id

    from nanoid import generate

    from getgather.config import FRIENDLY_CHARS

    recording_id = generate(FRIENDLY_CHARS, 12)
    frames_dir = Path(tempfile.mkdtemp(prefix=f"gg-rec-{recording_id}-"))

    started_ts = asyncio.get_event_loop().time()
    started_at = datetime.now(timezone.utc).isoformat()

    meta = RecordingMeta(
        recording_id=recording_id,
        signin_id=signin_id,
        browser_id=browser_id,
        started_at=started_at,
        stopped_at=None,
        duration_seconds=None,
        storage_key="",
        storage_backend=settings.RECORDING_STORAGE,
    )

    recording = _ActiveRecording(
        meta=meta,
        page=page,
        frames_dir=frames_dir,
        frame_count=0,
        timeout_task=asyncio.create_task(_timeout_stop(signin_id)),
        started_ts=started_ts,
    )
    _active[signin_id] = recording

    async def on_frame(event: cdp_page.ScreencastFrame) -> None:
        rec = _active.get(signin_id)
        if rec is None:
            return
        frame_path = rec.frames_dir / f"{rec.frame_count:06d}.jpg"
        frame_path.write_bytes(base64.b64decode(event.data))
        rec.frame_count += 1
        try:
            await page.send(cdp_page.screencast_frame_ack(session_id=event.session_id))
        except Exception as e:
            logger.debug(f"screencast_frame_ack failed: {e}")

    page.add_handler(cdp_page.ScreencastFrame, on_frame)  # type: ignore[arg-type]

    try:
        await page.send(
            cdp_page.start_screencast(
                format_="jpeg",
                quality=_SCREENCAST_QUALITY,
                max_width=_SCREENCAST_MAX_WIDTH,
                max_height=_SCREENCAST_MAX_HEIGHT,
                every_nth_frame=_SCREENCAST_NTH_FRAME,
            )
        )
        logger.info(f"Recording started: {recording_id} for signin {signin_id}")
    except Exception as e:
        logger.error(f"start_screencast failed for {signin_id}: {e}")
        _active.pop(signin_id, None)
        shutil.rmtree(frames_dir, ignore_errors=True)
        recording.timeout_task.cancel()
    return recording_id


async def stop_recording(signin_id: str) -> RecordingMeta | None:
    recording = _active.pop(signin_id, None)
    if recording is None:
        return None

    recording.timeout_task.cancel()

    try:
        await recording.page.send(cdp_page.stop_screencast())
    except Exception as e:
        logger.warning(f"stop_screencast failed for {signin_id}: {e}")

    elapsed = asyncio.get_event_loop().time() - recording.started_ts
    stopped_at = datetime.now(timezone.utc).isoformat()

    recording.meta.stopped_at = stopped_at
    recording.meta.duration_seconds = round(elapsed, 2)

    actual_frames = len(list(recording.frames_dir.glob("*.jpg")))
    if actual_frames == 0:
        logger.warning(f"Recording {recording.meta.recording_id} has no frames on disk, discarding")
        shutil.rmtree(recording.frames_dir, ignore_errors=True)
        return recording.meta

    if actual_frames != recording.frame_count:
        logger.warning(
            f"Recording {recording.meta.recording_id}: "
            f"counter={recording.frame_count} but disk={actual_frames} frames"
        )

    try:
        storage_key = await _encode_and_store(recording)
        recording.meta.storage_key = storage_key
        await _write_meta(recording.meta)
        logger.info(
            f"Recording stopped: {recording.meta.recording_id} "
            f"({recording.frame_count} frames, {elapsed:.1f}s) → {storage_key}"
        )
    except Exception as e:
        logger.error(f"Recording encode/store failed for {recording.meta.recording_id}: {e}")
    finally:
        shutil.rmtree(recording.frames_dir, ignore_errors=True)

    return recording.meta


async def _timeout_stop(signin_id: str) -> None:
    await asyncio.sleep(_RECORDING_TIMEOUT)
    if signin_id in _active:
        logger.info(f"Recording timeout reached for {signin_id}, stopping")
        await stop_recording(signin_id)


async def _encode_and_store(recording: _ActiveRecording) -> str:
    recording_id = recording.meta.recording_id
    mp4_path = recording.frames_dir / f"{recording_id}.mp4"

    cmd = [
        "ffmpeg",
        "-y",
        "-framerate",
        str(_SCREENCAST_FPS),
        "-i",
        str(recording.frames_dir / "%06d.jpg"),
        "-vf",
        "crop=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "28",
        str(mp4_path),
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        logger.error(f"ffmpeg failed for {recording_id}: {stderr.decode()[-500:]}")
        raise RuntimeError(f"ffmpeg encoding failed for {recording_id}")

    if settings.RECORDING_STORAGE == "s3":
        return await _upload_s3(recording_id, mp4_path)

    dest = settings.recordings_dir / f"{recording_id}.mp4"
    shutil.move(str(mp4_path), dest)
    return f"{recording_id}.mp4"


async def _write_meta(meta: RecordingMeta) -> None:
    payload = json.dumps(asdict(meta), indent=2)
    if settings.RECORDING_STORAGE == "s3":
        await asyncio.to_thread(_s3_put_object, f"{meta.recording_id}.json", payload.encode())
        return
    meta_path = settings.recordings_dir / f"{meta.recording_id}.json"
    meta_path.write_text(payload)


async def _upload_s3(recording_id: str, mp4_path: Path) -> str:
    key = f"{recording_id}.mp4"
    await asyncio.to_thread(_s3_upload_file, str(mp4_path), key)
    return key


def _s3_client() -> Any:  # boto3 ships no usable type stubs
    import boto3  # pyright: ignore[reportMissingTypeStubs]

    client: Any = boto3.client(  # pyright: ignore[reportUnknownMemberType,reportUnknownVariableType]
        "s3",
        endpoint_url=settings.AWS_ENDPOINT_URL or None,
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID or None,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY or None,
    )
    return client  # pyright: ignore[reportUnknownVariableType]


def _s3_upload_file(file_path: str, key: str) -> None:
    client: Any = _s3_client()
    client.upload_file(file_path, settings.TIGRIS_BUCKET, key)


def _s3_put_object(key: str, body: bytes) -> None:
    client: Any = _s3_client()
    client.put_object(Bucket=settings.TIGRIS_BUCKET, Key=key, Body=body)
