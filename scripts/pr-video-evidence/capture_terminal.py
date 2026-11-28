#!/usr/bin/env python3
"""Isolated terminal/backend capture renderer for CLI, API, DB, and infra PR evidence.

Executes real commands in an isolated process group, verifies assertions, redacts
secrets before rendering/logging, and renders crisp dark terminal frames synced to TTS.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import signal
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

SECRET_REDACT_PATTERNS = [
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    re.compile(r"\b(?:sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,})\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._-]{20,}\b", re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
]
SENSITIVE_ENV_RE = re.compile(
    r"(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)",
    re.IGNORECASE,
)


def sanitize_filename_token(token: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", token).strip(".-")
    return cleaned or "cue"


def redact(text: str) -> str:
    cleaned = text
    for pattern in SECRET_REDACT_PATTERNS:
        cleaned = pattern.sub("[REDACTED]", cleaned)
    return cleaned


def build_child_env(cue: dict) -> dict[str, str]:
    allowed = set(cue.get("allow_env") or [])
    env = {
        key: value
        for key, value in os.environ.items()
        if key in allowed or not SENSITIVE_ENV_RE.search(key)
    }
    for key, value in (cue.get("env") or {}).items():
        env[str(key)] = str(value)
    return env


def run_command_isolated(
    command: str, cwd: str, env: dict[str, str], timeout_seconds: int
) -> tuple[int, str]:
    proc = subprocess.Popen(
        command,
        shell=True,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, stderr = proc.communicate()
        snippet = redact(((stdout or "") + "\n" + (stderr or ""))[-400:])
        raise TimeoutError(
            f"Command timed out after {timeout_seconds}s: {redact(command)}\n{snippet}"
        )
    combined = (stdout or "") + (("\n" + stderr) if stderr else "")
    return proc.returncode, combined


def resolve_playwright_browsers_path() -> None:
    if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        return
    default_opt = Path("/opt/ms-playwright")
    if default_opt.is_dir():
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(default_opt)


def render_terminal_html(
    title: str,
    cue_label: str,
    command: str,
    output: str,
    exit_code: int,
    highlight_regex: re.Pattern | None,
) -> str:
    # Slice displayed lines before regex redaction so verbose outputs stay bounded.
    visible_lines = output.splitlines()[:26]
    escaped_lines = []
    for raw_line in visible_lines:
        clean_line = redact(raw_line)
        line_html = html.escape(clean_line)
        is_hit = bool(highlight_regex and highlight_regex.search(clean_line))
        cls = "line hit" if is_hit else "line"
        escaped_lines.append(f'<div class="{cls}">{line_html or "&nbsp;"}</div>')
    status_cls = "badge pass" if exit_code == 0 else "badge fail"
    status_text = f"EXIT {exit_code}"
    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    width: 100vw;
    height: 100vh;
    background: #0d1117;
    color: #e6edf3;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    padding: 48px 64px 132px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }}
  .header {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #30363d;
    padding-bottom: 16px;
  }}
  .title {{
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 26px;
    font-weight: 700;
    color: #f0f6fc;
  }}
  .cue {{
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 17px;
    color: #f59e0b;
    font-weight: 600;
  }}
  .terminal {{
    flex: 1;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 14px;
    padding: 24px 28px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }}
  .cmd-row {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #0d1117;
    border: 1px solid #30363d;
    border-left: 4px solid #f59e0b;
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 19px;
  }}
  .prompt {{ color: #f59e0b; margin-right: 10px; }}
  .badge {{
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 14px;
    font-weight: 700;
    padding: 5px 12px;
    border-radius: 999px;
  }}
  .badge.pass {{ background: rgba(16, 185, 129, 0.18); color: #34d399; border: 1px solid #10b981; }}
  .badge.fail {{ background: rgba(239, 68, 68, 0.18); color: #f87171; border: 1px solid #ef4444; }}
  .output {{
    font-size: 18px;
    line-height: 1.46;
    white-space: pre-wrap;
    overflow: hidden;
  }}
  .line {{ padding: 2px 8px; border-radius: 4px; }}
  .line.hit {{
    background: rgba(245, 158, 11, 0.18);
    border-left: 3px solid #f59e0b;
    color: #fef3c7;
  }}
</style>
</head>
<body>
  <div class="header">
    <div class="title">{html.escape(title)}</div>
    <div class="cue">{html.escape(cue_label)}</div>
  </div>
  <div class="terminal">
    <div class="cmd-row">
      <div><span class="prompt">$</span>{html.escape(redact(command))}</div>
      <div class="{status_cls}">{status_text}</div>
    </div>
    <div class="output">{"".join(escaped_lines)}</div>
  </div>
</body>
</html>"""


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Capture narrated terminal/API verification video."
    )
    parser.add_argument("--plan", required=True)
    parser.add_argument("--tts-manifest", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    resolve_playwright_browsers_path()
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    tts_manifest = json.loads(Path(args.tts_manifest).read_text(encoding="utf-8"))
    segments_by_id = {seg["id"]: seg for seg in tts_manifest["segments"]}

    width = int(plan.get("width", 1920))
    height = int(plan.get("height", 1080))
    fps = int(plan.get("fps", 30))
    cwd = plan.get("cwd") or os.getcwd()
    out_dir = Path(args.out_dir)
    slides_dir = out_dir / "terminal-frames"
    slides_dir.mkdir(parents=True, exist_ok=True)

    cues = plan.get("cues") or []
    seen_ids: set[str] = set()
    executed_slides = []
    timeline_cues = []
    cursor_s = 0.0

    # Execute all commands and assertions first so Chromium is not held in RAM during long commands.
    for index, cue in enumerate(cues, start=1):
        cue_id = str(cue.get("id") or f"cue-{index:02d}").strip()
        if cue_id in seen_ids:
            raise SystemExit(f"Duplicate cue id in plan: {cue_id!r}")
        seen_ids.add(cue_id)
        seg = segments_by_id[cue_id]
        audio_duration = float(seg["duration_seconds"])
        hold = round(audio_duration + float(cue.get("post_hold_seconds", 0.65)), 3)

        highlight_pattern = cue.get("highlight_pattern")
        highlight_regex = None
        if highlight_pattern:
            try:
                highlight_regex = re.compile(str(highlight_pattern))
            except re.error as err:
                raise ValueError(
                    f"Invalid highlight_pattern regex in cue {cue_id}: {err}"
                ) from err

        command = str(cue["command"])
        expected_exit = int(cue.get("expected_exit_code", 0))
        exit_code, combined_output = run_command_isolated(
            command=command,
            cwd=cwd,
            env=build_child_env(cue),
            timeout_seconds=int(cue.get("timeout_seconds", 120)),
        )
        if exit_code != expected_exit:
            raise RuntimeError(
                f"Cue {cue_id} command failed (expected exit {expected_exit}, got {exit_code}): "
                f"{redact(combined_output[-600:])}"
            )
        for expected_text in cue.get("assert_output_contains") or []:
            if expected_text not in combined_output:
                raise AssertionError(
                    f"Cue {cue_id} output did not contain expected text: {expected_text!r}"
                )

        html_doc = render_terminal_html(
            title=str(plan.get("title") or "Backend / CLI Verification"),
            cue_label=str(cue.get("label") or cue_id),
            command=command,
            output=combined_output.strip() or "(no output)",
            exit_code=exit_code,
            highlight_regex=highlight_regex,
        )
        safe_token = sanitize_filename_token(cue_id)
        frame_path = slides_dir / f"{index:02d}-{safe_token}.png"
        executed_slides.append((frame_path, html_doc, hold))

        timeline_cues.append(
            {
                "id": cue_id,
                "acceptance_criterion_id": cue.get("acceptance_criterion_id"),
                "acceptance_criterion": cue.get("acceptance_criterion"),
                "narration": seg["narration"],
                "wav": seg["wav"],
                "audio_duration_seconds": audio_duration,
                "start_seconds": round(cursor_s, 3),
                "end_seconds": round(cursor_s + hold, 3),
                "command": redact(command),
                "exit_code": exit_code,
            }
        )
        cursor_s += hold

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": width, "height": height})
            for frame_path, html_doc, _hold in executed_slides:
                page.set_content(html_doc, wait_until="load")
                page.screenshot(path=str(frame_path))
        finally:
            browser.close()

    concat_file = out_dir / "terminal-concat.txt"
    lines = []
    for frame_path, _html_doc, duration in executed_slides:
        escaped = str(frame_path.resolve()).replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
        lines.append(f"duration {duration:.3f}")
    if executed_slides:
        escaped_last = str(executed_slides[-1][0].resolve()).replace("'", "'\\''")
        lines.append(f"file '{escaped_last}'")
    concat_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    raw_video = out_dir / "raw-capture.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_file),
            "-vf",
            f"fps={fps},scale={width}:{height},format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "stillimage",
            "-crf",
            "18",
            str(raw_video),
        ],
        check=True,
        timeout=180,
    )

    timeline = {
        "target": plan.get("target", "terminal"),
        "width": width,
        "height": height,
        "raw_video": str(raw_video),
        "playwright_trace": None,
        "observed_routes": plan.get("routes") or ["terminal"],
        "total_duration_seconds": round(cursor_s, 3),
        "cues": timeline_cues,
    }
    (out_dir / "timeline.json").write_text(
        json.dumps(timeline, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"[capture-terminal] rendered {len(timeline_cues)} cues ({cursor_s:.2f}s) -> {raw_video}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
