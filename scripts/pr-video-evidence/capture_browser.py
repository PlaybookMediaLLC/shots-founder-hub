#!/usr/bin/env python3
"""Playwright browser capture with synchronized cursor, click indicators,
element bounding-box highlights, restrained zoom, and trace preservation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Page, expect, sync_playwright

OVERLAY_INIT_SCRIPT = r"""
(() => {
  if (window.__prEvidenceHudInstalled) return;
  window.__prEvidenceHudInstalled = true;

  const ensureRoot = () => {
    let root = document.getElementById("__pr-evidence-hud");
    if (root) return root;
    if (!document.documentElement) return null;

    if (!document.getElementById("__pr-evidence-hud-style")) {
      const style = document.createElement("style");
      style.id = "__pr-evidence-hud-style";
      style.textContent = `
      html {
        transition: transform 380ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #__pr-evidence-hud {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483647;
        overflow: hidden;
      }
      #__pr-evidence-box {
        position: fixed;
        display: none;
        border: 3px solid #f59e0b;
        background: rgba(245, 158, 11, 0.10);
        border-radius: 10px;
        box-shadow: 0 0 0 1px rgba(24, 22, 19, 0.25), 0 8px 24px rgba(0, 0, 0, 0.16);
        transition: left 240ms ease, top 240ms ease, width 240ms ease, height 240ms ease, opacity 180ms ease;
      }
      #__pr-evidence-label {
        position: fixed;
        display: none;
        background: #181613;
        color: #fffdf9;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 15px;
        font-weight: 600;
        line-height: 1.25;
        padding: 6px 12px;
        border-radius: 8px;
        border: 1.5px solid #f59e0b;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
        white-space: nowrap;
      }
      #__pr-evidence-cursor {
        position: fixed;
        left: 60px;
        top: 60px;
        width: 28px;
        height: 28px;
        transform: translate(-3px, -2px);
        transition: left 420ms cubic-bezier(0.22, 1, 0.36, 1), top 420ms cubic-bezier(0.22, 1, 0.36, 1);
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4));
      }
      .__pr-evidence-click-ring {
        position: fixed;
        width: 22px;
        height: 22px;
        margin-left: -11px;
        margin-top: -11px;
        border-radius: 9999px;
        border: 3px solid #f59e0b;
        background: rgba(245, 158, 11, 0.22);
        animation: __prEvidencePulse 650ms ease-out forwards;
      }
      @keyframes __prEvidencePulse {
        0% { transform: scale(0.4); opacity: 1; }
        100% { transform: scale(2.8); opacity: 0; }
      }
    `;
      (document.head || document.documentElement).appendChild(style);
    }

    root = document.createElement("div");
    root.id = "__pr-evidence-hud";
    root.innerHTML = `
      <div id="__pr-evidence-box"></div>
      <div id="__pr-evidence-label"></div>
      <div id="__pr-evidence-cursor">
        <svg viewBox="0 0 28 28" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 3L23 13.5L14.5 15.8L11.4 24L4 3Z" fill="#181613" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </div>
    `;
    document.documentElement.appendChild(root);
    return root;
  };

  const getFixedOffset = () => {
    const transformed = Boolean(document.documentElement.style.transform);
    return {
      dx: transformed ? window.scrollX : 0,
      dy: transformed ? window.scrollY : 0,
    };
  };

  window.__prEvidence = {
    moveCursor(x, y) {
      ensureRoot();
      const cursor = document.getElementById("__pr-evidence-cursor");
      if (!cursor) return;
      const { dx, dy } = getFixedOffset();
      cursor.style.left = `${Math.round(x + dx)}px`;
      cursor.style.top = `${Math.round(y + dy)}px`;
    },
    clickPulse(x, y) {
      const root = ensureRoot();
      if (!root) return;
      const { dx, dy } = getFixedOffset();
      const ring = document.createElement("div");
      ring.className = "__pr-evidence-click-ring";
      ring.style.left = `${Math.round(x + dx)}px`;
      ring.style.top = `${Math.round(y + dy)}px`;
      root.appendChild(ring);
      setTimeout(() => ring.remove(), 750);
    },
    highlightRect(rect, label, color, zoom) {
      ensureRoot();
      const box = document.getElementById("__pr-evidence-box");
      const tag = document.getElementById("__pr-evidence-label");
      const root = document.documentElement;
      if (!box || !tag) return;
      if (!rect) {
        box.style.display = "none";
        tag.style.display = "none";
        root.style.transformOrigin = "0px 0px";
        root.style.transform = "";
        return;
      }

      const willZoom = Boolean(zoom && zoom > 1.01);
      if (willZoom) {
        const ox = Math.round(rect.cx + window.scrollX);
        const oy = Math.round(rect.cy + window.scrollY);
        root.style.transformOrigin = `${ox}px ${oy}px`;
        root.style.transform = `scale(${Number(zoom).toFixed(3)})`;
      } else {
        root.style.transformOrigin = "0px 0px";
        root.style.transform = "";
      }

      const { dx, dy } = getFixedOffset();
      const pad = 6;
      const accent = color || "#f59e0b";
      const left = Math.max(4, rect.x - pad);
      const top = Math.max(4, rect.y - pad);
      const width = Math.min(window.innerWidth - left - 4, rect.width + pad * 2);
      const height = Math.min(window.innerHeight - top - 4, rect.height + pad * 2);
      box.style.display = "block";
      box.style.left = `${left + dx}px`;
      box.style.top = `${top + dy}px`;
      box.style.width = `${Math.max(16, width)}px`;
      box.style.height = `${Math.max(16, height)}px`;
      box.style.borderColor = accent;
      box.style.background = accent === "#10b981"
        ? "rgba(16, 185, 129, 0.10)"
        : accent === "#ef4444"
          ? "rgba(239, 68, 68, 0.10)"
          : "rgba(245, 158, 11, 0.10)";

      if (label) {
        tag.textContent = label;
        tag.style.display = "block";
        tag.style.borderColor = accent;
        const placeAbove = top > 48;
        const tagTop = placeAbove ? top - 38 : Math.min(window.innerHeight - 110, top + height + 8);
        const tagLeft = Math.min(window.innerWidth - 360, left);
        tag.style.left = `${Math.max(8, tagLeft) + dx}px`;
        tag.style.top = `${Math.max(8, tagTop) + dy}px`;
      } else {
        tag.style.display = "none";
      }

      this.moveCursor(rect.cx, rect.cy);
    },
    resetZoom() {
      const root = document.documentElement;
      if (!root.style.transform) return;
      root.style.transition = "none";
      root.style.transformOrigin = "0px 0px";
      root.style.transform = "";
      void root.offsetWidth;
      root.style.transition = "";
    },
    setZoom(scale, originX, originY) {
      const root = document.documentElement;
      if (!scale || scale <= 1.01) {
        root.style.transformOrigin = "0px 0px";
        root.style.transform = "";
        return;
      }
      const ox = Math.round(originX + window.scrollX);
      const oy = Math.round(originY + window.scrollY);
      root.style.transformOrigin = `${ox}px ${oy}px`;
      root.style.transform = `scale(${scale.toFixed(3)})`;
    },
  };

  if (document.readyState !== "loading") {
    ensureRoot();
  } else {
    window.addEventListener("DOMContentLoaded", ensureRoot, { once: true });
  }
})();
"""


def resolve_playwright_browsers_path() -> None:
    if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        return
    default_opt = Path("/opt/ms-playwright")
    if default_opt.is_dir():
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(default_opt)


def resolve_locator(page: Page, target: str | dict, first: bool = True):
    if isinstance(target, str):
        loc = page.locator(target)
    elif isinstance(target, dict):
        if "role" in target:
            opts = {}
            if "name" in target:
                opts["name"] = target["name"]
            if "exact" in target:
                opts["exact"] = bool(target["exact"])
            loc = page.get_by_role(target["role"], **opts)
        elif "text" in target:
            loc = page.get_by_text(
                target["text"], exact=bool(target.get("exact", False))
            )
        elif "label" in target:
            loc = page.get_by_label(target["label"])
        elif "selector" in target:
            loc = page.locator(target["selector"])
        else:
            raise ValueError(f"Unsupported locator specification: {target!r}")
    else:
        raise ValueError(f"Unsupported locator specification: {target!r}")
    return loc.first if first else loc


def get_box_center(locator) -> dict | None:
    try:
        locator.scroll_into_view_if_needed(timeout=5000)
        box = locator.bounding_box(timeout=5000)
        if not box:
            return None
        return {
            "x": box["x"],
            "y": box["y"],
            "width": box["width"],
            "height": box["height"],
            "cx": box["x"] + box["width"] / 2.0,
            "cy": box["y"] + box["height"] / 2.0,
        }
    except Exception:
        return None


def apply_highlight(
    page: Page,
    locator,
    label: str | None,
    color: str | None,
    zoom: float | None,
):
    if locator is None:
        page.evaluate("() => window.__prEvidence?.highlightRect(null)")
        return None
    # Reset any previous CSS zoom before measuring bounding_box() so coordinates
    # stay accurate in unscaled viewport space.
    page.evaluate("() => window.__prEvidence?.resetZoom()")
    rect = get_box_center(locator)
    if not rect:
        return None
    page.evaluate(
        "([r, lbl, clr, z]) => window.__prEvidence?.highlightRect(r, lbl, clr, z)",
        [rect, label or "", color or "#f59e0b", float(zoom) if zoom else 1.0],
    )
    return rect


def extract_route(page_url: str, base_url: str) -> str | None:
    if not page_url:
        return None
    base_parts = urlsplit(base_url)
    page_parts = urlsplit(page_url)
    if page_parts.scheme != base_parts.scheme or page_parts.netloc != base_parts.netloc:
        return None
    route = page_parts.path or "/"
    if page_parts.query:
        route = f"{route}?{page_parts.query}"
    return route


def run_step(page: Page, step: dict, base_url: str) -> dict:
    action = step["action"]
    target = step.get("target")
    label = step.get("label")
    color = step.get("color")
    zoom = step.get("zoom")

    if action == "goto":
        url = step["url"]
        if url.startswith("/"):
            url = base_url.rstrip("/") + url
        wait_until = str(step.get("wait_until", "load"))
        page.goto(url, wait_until=wait_until, timeout=30000)
        page.evaluate("() => window.__prEvidence?.setZoom(1, 960, 540)")
        if target:
            loc = resolve_locator(page, target)
            loc.wait_for(state="visible", timeout=15000)
            apply_highlight(page, loc, label, color, zoom)
        return {"action": action, "url": page.url, "status": "passed"}

    if action == "highlight":
        loc = resolve_locator(page, target)
        loc.wait_for(state="visible", timeout=15000)
        apply_highlight(page, loc, label, color, zoom)
        return {"action": action, "status": "passed"}

    if action == "click":
        loc = resolve_locator(page, target)
        loc.wait_for(state="visible", timeout=15000)
        rect = apply_highlight(page, loc, label, color, zoom)
        page.wait_for_timeout(420)
        if rect:
            page.evaluate(
                "([x, y]) => window.__prEvidence?.clickPulse(x, y)",
                [rect["cx"], rect["cy"]],
            )
            page.wait_for_timeout(160)
        loc.click(timeout=15000)
        wait_state = step.get("wait_for_load_state")
        if wait_state:
            page.wait_for_load_state(str(wait_state), timeout=15000)
        else:
            page.wait_for_timeout(int(step.get("settle_ms", 250)))
        return {"action": action, "url": page.url, "status": "passed"}

    if action == "fill":
        loc = resolve_locator(page, target)
        loc.wait_for(state="visible", timeout=15000)
        rect = apply_highlight(page, loc, label, color, zoom)
        page.wait_for_timeout(320)
        if rect:
            page.evaluate(
                "([x, y]) => window.__prEvidence?.clickPulse(x, y)",
                [rect["cx"], rect["cy"]],
            )
        loc.fill(str(step.get("value", "")))
        return {"action": action, "status": "passed"}

    if action == "press":
        if target:
            loc = resolve_locator(page, target)
            loc.press(str(step["key"]))
        else:
            page.keyboard.press(str(step["key"]))
        return {"action": action, "status": "passed"}

    if action == "scroll":
        dy = int(step.get("dy", 400))
        page.mouse.wheel(0, dy)
        page.wait_for_timeout(300)
        return {"action": action, "status": "passed"}

    if action == "clear_highlight":
        apply_highlight(page, None, None, None, None)
        return {"action": action, "status": "passed"}

    if action == "assert_visible":
        loc = resolve_locator(page, target)
        expect(loc).to_be_visible(timeout=15000)
        apply_highlight(page, loc, label, color or "#10b981", zoom)
        return {"action": action, "status": "passed"}

    if action == "assert_text":
        loc = resolve_locator(page, target)
        expected_text = str(step["expected"])
        expect(loc).to_contain_text(expected_text, timeout=15000)
        apply_highlight(page, loc, label, color or "#10b981", zoom)
        return {"action": action, "expected": expected_text, "status": "passed"}

    if action == "assert_url":
        contains = str(step["contains"])
        expect(page).to_have_url(re.compile(re.escape(contains)), timeout=15000)
        return {"action": action, "url": page.url, "status": "passed"}

    if action == "assert_count_min":
        loc = resolve_locator(page, target, first=False)
        minimum = int(step.get("min", 1))
        if minimum > 0:
            expect(loc.nth(minimum - 1)).to_be_attached(timeout=15000)
        count = loc.count()
        if count < minimum:
            raise AssertionError(f"Expected at least {minimum} matches, found {count}")
        return {"action": action, "count": count, "status": "passed"}

    raise ValueError(f"Unknown browser step action: {action!r}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Capture narrated browser video evidence."
    )
    parser.add_argument("--plan", required=True, help="Path to verification plan JSON")
    parser.add_argument(
        "--tts-manifest", required=True, help="Path to tts-manifest.json"
    )
    parser.add_argument("--out-dir", required=True, help="Output directory")
    args = parser.parse_args()

    resolve_playwright_browsers_path()
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    tts_manifest = json.loads(Path(args.tts_manifest).read_text(encoding="utf-8"))

    width = int(plan.get("width", 1920))
    height = int(plan.get("height", 1080))
    base_url = str(plan.get("base_url") or "")
    if not base_url:
        raise SystemExit("Browser plan requires 'base_url'.")

    cues = plan.get("cues") or []
    seen_ids: set[str] = set()
    for index, cue in enumerate(cues, start=1):
        cid = str(cue.get("id") or f"cue-{index:02d}").strip()
        if cid in seen_ids:
            raise SystemExit(f"Duplicate cue id in plan: {cid!r}")
        seen_ids.add(cid)

    out_dir = Path(args.out_dir)
    video_dir = out_dir / "raw-video"
    video_dir.mkdir(parents=True, exist_ok=True)
    trace_path = out_dir / "trace.zip"

    segments_by_id = {seg["id"]: seg for seg in tts_manifest["segments"]}
    timeline_cues = []
    observed_routes: list[str] = []
    raw_video_src: Path | None = None
    total_duration = 0.0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = None
        page = None
        tracing_started = False
        try:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
                record_video_dir=str(video_dir),
                record_video_size={"width": width, "height": height},
            )
            context.add_init_script(OVERLAY_INIT_SCRIPT)
            # Video already captures 1080p frames; snapshots + sources preserve DOM/action trace
            # without duplicating full-frame screencast overhead.
            context.tracing.start(
                screenshots=bool(plan.get("trace_screenshots", False)),
                snapshots=True,
                sources=True,
            )
            tracing_started = True
            page = context.new_page()

            video_t0 = time.monotonic()
            page.wait_for_timeout(450)

            for index, cue in enumerate(cues, start=1):
                cue_id = str(cue.get("id") or f"cue-{index:02d}").strip()
                seg = segments_by_id[cue_id]
                audio_duration = float(seg["duration_seconds"])

                cue_start = time.monotonic() - video_t0
                step_results = []
                for step in cue.get("steps") or []:
                    result = run_step(page, step, base_url)
                    step_results.append(result)
                    route = extract_route(page.url, base_url)
                    if route and route not in observed_routes:
                        observed_routes.append(route)

                elapsed = (time.monotonic() - video_t0) - cue_start
                min_hold = audio_duration + float(cue.get("post_hold_seconds", 0.55))
                if elapsed < min_hold:
                    page.wait_for_timeout(int((min_hold - elapsed) * 1000))

                cue_end = time.monotonic() - video_t0
                timeline_cues.append(
                    {
                        "id": cue_id,
                        "acceptance_criterion_id": cue.get("acceptance_criterion_id"),
                        "acceptance_criterion": cue.get("acceptance_criterion"),
                        "narration": seg["narration"],
                        "wav": seg["wav"],
                        "audio_duration_seconds": audio_duration,
                        "start_seconds": round(cue_start, 3),
                        "end_seconds": round(cue_end, 3),
                        "url": page.url,
                        "steps": step_results,
                    }
                )

            page.evaluate("() => window.__prEvidence?.setZoom(1, 960, 540)")
            page.wait_for_timeout(500)
            total_duration = round(time.monotonic() - video_t0, 3)
        finally:
            try:
                if context is not None:
                    if tracing_started:
                        try:
                            context.tracing.stop(path=str(trace_path))
                        except Exception:
                            pass
                    video_obj = page.video if page is not None else None
                    try:
                        context.close()
                    finally:
                        if video_obj is not None:
                            try:
                                raw_video_src = Path(video_obj.path())
                            except Exception:
                                raw_video_src = None
            finally:
                browser.close()

    if raw_video_src is None or not raw_video_src.is_file():
        raise RuntimeError("Playwright failed to produce a raw video capture.")

    raw_video_dest = out_dir / f"raw-capture{raw_video_src.suffix}"
    raw_video_src.replace(raw_video_dest)
    try:
        video_dir.rmdir()
    except OSError:
        pass

    timeline = {
        "target": plan.get("target", "web"),
        "width": width,
        "height": height,
        "raw_video": str(raw_video_dest),
        "playwright_trace": str(trace_path),
        "observed_routes": observed_routes or plan.get("routes") or ["/"],
        "total_duration_seconds": total_duration,
        "cues": timeline_cues,
    }
    (out_dir / "timeline.json").write_text(
        json.dumps(timeline, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"[capture] captured {len(timeline_cues)} cues ({total_duration:.2f}s) -> {raw_video_dest}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
