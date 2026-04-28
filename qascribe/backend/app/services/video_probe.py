"""Probe video files to get duration without invoking any AI API.

Critical for cost control: we MUST know duration before estimating cost.
"""
import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class VideoInfo:
    duration_seconds: float
    size_bytes: int
    has_audio: bool
    width: int
    height: int
    codec: str


def probe_video(file_path: str | Path) -> VideoInfo:
    """Run ffprobe to get video info. ffprobe must be on PATH."""
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Video not found: {path}")

    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except FileNotFoundError as e:
        raise FileNotFoundError(
            "ffprobe not found. Install ffmpeg and ensure it is on PATH. "
            "Windows: 'winget install ffmpeg' (then restart all terminals). "
            "macOS: 'brew install ffmpeg'. Linux: 'apt install ffmpeg'."
        ) from e
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")

    data = json.loads(result.stdout)
    duration = float(data["format"].get("duration", 0))
    size = int(data["format"].get("size", path.stat().st_size))

    video_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"), None
    )
    audio_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None
    )

    if not video_stream:
        raise ValueError("File has no video stream")

    return VideoInfo(
        duration_seconds=duration,
        size_bytes=size,
        has_audio=audio_stream is not None,
        width=int(video_stream.get("width", 0)),
        height=int(video_stream.get("height", 0)),
        codec=video_stream.get("codec_name", "unknown"),
    )


def extract_audio_track(video_path: str | Path, output_path: str | Path) -> Path:
    """Extract audio to a separate mp3 for STT."""
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-vn", "-acodec", "libmp3lame", "-q:a", "4",
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extraction failed: {result.stderr}")
    return Path(output_path)
