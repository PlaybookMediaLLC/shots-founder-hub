#!/usr/bin/env python3
"""Local-first TTS generator for PR narrated video evidence.

Default provider: Kokoro ONNX (kokoro-onnx) with pinned SHA-256 weight verification.
Fallbacks: local espeak-ng, or explicitly opted-in OpenAI TTS (with secret scan).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import wave
from pathlib import Path
from typing import Callable

KOKORO_RELEASE_BASE = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
)
DEFAULT_KOKORO_DIR = Path.home() / ".cache" / "kokoro-onnx"
KOKORO_FILES = {
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
}
OPENAI_VOICES = {
    "alloy",
    "ash",
    "coral",
    "echo",
    "fable",
    "onyx",
    "nova",
    "sage",
    "shimmer",
}
SECRET_PATTERNS = [
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    re.compile(r"\b(?:sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,})\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._-]{20,}\b", re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
]


def sanitize_filename_token(token: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", token).strip(".-")
    return cleaned or "cue"


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def wav_duration_seconds(wav_path: Path) -> float:
    with wave.open(str(wav_path), "rb") as wf:
        frames = wf.getnframes()
        rate = wf.getframerate()
        if rate <= 0:
            raise RuntimeError(f"Invalid WAV sample rate in {wav_path}")
        return frames / float(rate)


def normalize_wav(input_path: Path, output_path: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-ac",
        "1",
        "-ar",
        "48000",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, timeout=60)


def validate_cues(cues: list[dict]) -> list[tuple[str, str, str]]:
    if not cues:
        raise ValueError("Plan must contain a non-empty 'cues' array.")
    seen_ids: set[str] = set()
    validated: list[tuple[str, str, str]] = []
    for index, cue in enumerate(cues, start=1):
        cue_id = str(cue.get("id") or f"cue-{index:02d}").strip()
        if not cue_id:
            raise ValueError(f"Cue #{index} has an empty id.")
        if cue_id in seen_ids:
            raise ValueError(f"Duplicate cue id detected: {cue_id!r}")
        seen_ids.add(cue_id)
        text = str(cue.get("narration") or "").strip()
        if not text:
            raise ValueError(f"Cue {cue_id} is missing narration text.")
        validated.append((cue_id, sanitize_filename_token(cue_id), text))
    return validated


def assert_no_secrets(text: str, cue_id: str) -> None:
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            raise ValueError(
                f"Refusing to send cue {cue_id} to external TTS: secret-like token detected."
            )


def download_verified(url: str, target: Path, expected_sha256: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".part", dir=str(target.parent)
    )
    tmp_path = Path(tmp_name)
    try:
        digest = hashlib.sha256()
        with os.fdopen(fd, "wb") as out_file:
            with urllib.request.urlopen(url, timeout=120) as response:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    out_file.write(chunk)
        actual = digest.hexdigest()
        if actual != expected_sha256:
            raise RuntimeError(
                f"SHA-256 mismatch for {target.name}: expected {expected_sha256}, got {actual}"
            )
        os.replace(tmp_path, target)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def ensure_kokoro_weights(cache_dir: Path, auto_download: bool) -> tuple[Path, Path]:
    paths: dict[str, Path] = {}
    for filename, expected_sha in KOKORO_FILES.items():
        target = cache_dir / filename
        if target.is_file():
            actual_sha = sha256_file(target)
            if actual_sha != expected_sha:
                raise RuntimeError(
                    f"Cached Kokoro file {target} failed SHA-256 verification "
                    f"(expected {expected_sha}, got {actual_sha}). Delete and re-download."
                )
            paths[filename] = target
            continue
        if not auto_download:
            raise FileNotFoundError(
                f"Kokoro weights missing in {cache_dir}. Pass --auto-download or download "
                f"kokoro-v1.0.onnx and voices-v1.0.bin."
            )
        download_verified(f"{KOKORO_RELEASE_BASE}/{filename}", target, expected_sha)
        paths[filename] = target
    return paths["kokoro-v1.0.onnx"], paths["voices-v1.0.bin"]


def run_cue_synthesis(
    validated_cues: list[tuple[str, str, str]],
    out_dir: Path,
    render_raw: Callable[[str, str, Path], None],
) -> list[dict]:
    segments = []
    for index, (cue_id, safe_token, text) in enumerate(validated_cues, start=1):
        raw_wav = out_dir / f"{index:02d}-{safe_token}.raw.wav"
        norm_wav = out_dir / f"{index:02d}-{safe_token}.wav"
        try:
            render_raw(cue_id, text, raw_wav)
            normalize_wav(raw_wav, norm_wav)
        finally:
            raw_wav.unlink(missing_ok=True)
        duration = round(wav_duration_seconds(norm_wav), 3)
        segments.append(
            {
                "id": cue_id,
                "narration": text,
                "wav": str(norm_wav),
                "duration_seconds": duration,
            }
        )
    return segments


def init_kokoro(auto_download: bool):
    from kokoro_onnx import Kokoro
    import soundfile as sf

    cache_dir = Path(os.environ.get("KOKORO_CACHE_DIR", str(DEFAULT_KOKORO_DIR)))
    model_path, voices_path = ensure_kokoro_weights(cache_dir, auto_download)
    return Kokoro(str(model_path), str(voices_path)), sf


def synthesize_kokoro(
    kokoro,
    sf,
    validated_cues: list[tuple[str, str, str]],
    out_dir: Path,
    voice: str,
    speed: float,
) -> tuple[str, str, list[dict]]:
    def render_raw(_cue_id: str, text: str, raw_wav: Path) -> None:
        samples, sample_rate = kokoro.create(
            text, voice=voice, speed=speed, lang="en-us"
        )
        sf.write(str(raw_wav), samples, sample_rate)

    return "kokoro-onnx", voice, run_cue_synthesis(validated_cues, out_dir, render_raw)


def synthesize_espeak(
    validated_cues: list[tuple[str, str, str]], out_dir: Path, speed: float
) -> tuple[str, str, list[dict]]:
    binary = shutil.which("espeak-ng") or shutil.which("espeak")
    if not binary:
        raise RuntimeError("espeak-ng is not installed.")
    wpm = max(110, min(240, int(round(165 * speed))))

    def render_raw(_cue_id: str, text: str, raw_wav: Path) -> None:
        subprocess.run(
            [binary, "-s", str(wpm), "-w", str(raw_wav), "--", text],
            check=True,
            timeout=60,
        )

    return (
        "espeak-ng",
        "default",
        run_cue_synthesis(validated_cues, out_dir, render_raw),
    )


def synthesize_openai(
    validated_cues: list[tuple[str, str, str]],
    out_dir: Path,
    voice: str,
    speed: float,
) -> tuple[str, str, list[dict]]:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required when --provider=openai.")
    for cue_id, _safe_token, text in validated_cues:
        assert_no_secrets(text, cue_id)
    model = os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
    selected_voice = voice if voice in OPENAI_VOICES else "alloy"

    def render_raw(_cue_id: str, text: str, raw_wav: Path) -> None:
        payload = json.dumps(
            {
                "model": model,
                "voice": selected_voice,
                "input": text,
                "response_format": "wav",
                "speed": speed,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            "https://api.openai.com/v1/audio/speech",
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            raw_wav.write_bytes(response.read())

    return (
        f"openai:{model}",
        selected_voice,
        run_cue_synthesis(validated_cues, out_dir, render_raw),
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Synthesize per-cue narration WAV clips."
    )
    parser.add_argument("--plan", required=True, help="Path to verification plan JSON")
    parser.add_argument(
        "--out-dir", required=True, help="Output directory for audio clips"
    )
    parser.add_argument(
        "--provider",
        default="auto",
        choices=["auto", "kokoro", "espeak", "openai"],
        help="TTS provider (default: auto -> kokoro-onnx, fallback espeak-ng)",
    )
    parser.add_argument(
        "--voice", default="af_heart", help="Voice ID for Kokoro/OpenAI"
    )
    parser.add_argument(
        "--speed", type=float, default=1.02, help="Speech speed multiplier"
    )
    parser.add_argument(
        "--auto-download",
        action="store_true",
        help="Download verified Kokoro v1.0 ONNX weights into cache if missing",
    )
    args = parser.parse_args()

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    validated_cues = validate_cues(plan.get("cues") or [])

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.provider == "kokoro":
        kokoro, sf = init_kokoro(args.auto_download)
        provider_used, voice_used, segments = synthesize_kokoro(
            kokoro, sf, validated_cues, out_dir, args.voice, args.speed
        )
    elif args.provider == "espeak":
        provider_used, voice_used, segments = synthesize_espeak(
            validated_cues, out_dir, args.speed
        )
    elif args.provider == "openai":
        provider_used, voice_used, segments = synthesize_openai(
            validated_cues, out_dir, args.voice, args.speed
        )
    else:
        # Only fall back to espeak-ng when Kokoro package/weights are unavailable.
        try:
            kokoro, sf = init_kokoro(args.auto_download)
        except (ImportError, FileNotFoundError) as kokoro_err:
            print(
                f"[tts] kokoro-onnx unavailable ({kokoro_err}); falling back to espeak-ng",
                file=sys.stderr,
            )
            provider_used, voice_used, segments = synthesize_espeak(
                validated_cues, out_dir, args.speed
            )
        else:
            provider_used, voice_used, segments = synthesize_kokoro(
                kokoro, sf, validated_cues, out_dir, args.voice, args.speed
            )

    manifest = {
        "provider": provider_used,
        "voice": voice_used,
        "speed": args.speed,
        "segments": segments,
    }
    manifest_path = out_dir / "tts-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[tts] generated {len(segments)} clips via {provider_used} ({voice_used})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
