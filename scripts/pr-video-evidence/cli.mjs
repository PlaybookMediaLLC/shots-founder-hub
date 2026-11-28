import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { validatePrVideoEvidence } from "../verify-pr-video-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function assertBinary(name) {
  const probe = spawnSync("which", [name], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(`Required executable not found on PATH: ${name}`);
  }
}

function detectRepository() {
  for (const remoteName of ["upstream", "origin"]) {
    try {
      const remote = git(["remote", "get-url", remoteName]);
      const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i);
      if (match) return match[1];
    } catch {
      // Try next remote.
    }
  }
  return "";
}

function sanitizeFilenameToken(token) {
  const cleaned = String(token || "")
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^[.-]+|[.-]+$/g, "");
  return cleaned || "cue";
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function formatTimestampSrt(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function formatTimestampVtt(seconds) {
  return formatTimestampSrt(seconds).replace(",", ".");
}

function formatTimestampAss(seconds) {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCs / 360_000);
  const minutes = Math.floor((totalCs % 360_000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function formatMmSs(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeAssText(line) {
  // Neutralize libass override tags and \N/\n/\h escapes using a zero-width break after backslash.
  return line
    .replaceAll("\\", "\\\u200B")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}");
}

function escapeMarkdownTableCell(text) {
  return String(text ?? "")
    .replaceAll(/[\r\n]+/g, " ")
    .replaceAll("|", "\\|")
    .trim();
}

function wrapCaptionLines(text, maxChars = 76) {
  const words = text.trim().split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function splitCaptionSegments(text, maxSegmentChars = 128) {
  const sentences = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const segments = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxSegmentChars) {
      if (
        segments.length > 0 &&
        segments[segments.length - 1].length + 1 + sentence.length <=
          maxSegmentChars
      ) {
        segments[segments.length - 1] += ` ${sentence}`;
      } else {
        segments.push(sentence);
      }
      continue;
    }
    const words = sentence.split(/\s+/);
    let chunk = "";
    for (const word of words) {
      if (!chunk) {
        chunk = word;
      } else if (chunk.length + 1 + word.length <= maxSegmentChars) {
        chunk += ` ${word}`;
      } else {
        segments.push(chunk);
        chunk = word;
      }
    }
    if (chunk) segments.push(chunk);
  }
  return segments.length > 0 ? segments : [text.trim()];
}

function buildCaptionTracks(cues) {
  const srtBlocks = [];
  const vttBlocks = ["WEBVTT", ""];
  const assLines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Caption,DejaVu Sans,30,&H00FFFFFF,&H000000FF,&H00121212,&HC0121212,0,0,0,0,100,100,0,0,3,10,0,2,120,120,34,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const transcriptLines = [];
  let subtitleIndex = 1;

  cues.forEach((cue) => {
    const cueStart = cue.start_seconds;
    const cueEnd = Math.max(
      cueStart + 0.4,
      Math.min(cue.end_seconds, cueStart + cue.audio_duration_seconds + 0.25),
    );
    const totalDuration = cueEnd - cueStart;
    const segments = splitCaptionSegments(cue.narration);
    const totalChars = segments.reduce(
      (sum, s) => sum + Math.max(1, s.length),
      0,
    );

    let segStart = cueStart;
    segments.forEach((segment, segIdx) => {
      const share = Math.max(1, segment.length) / totalChars;
      const segEnd =
        segIdx === segments.length - 1
          ? cueEnd
          : segStart + totalDuration * share;
      const wrapped = wrapCaptionLines(segment, 68);

      srtBlocks.push(
        `${subtitleIndex}\n${formatTimestampSrt(segStart)} --> ${formatTimestampSrt(segEnd)}\n${wrapped.join("\n")}\n`,
      );
      vttBlocks.push(
        `${formatTimestampVtt(segStart)} --> ${formatTimestampVtt(segEnd)}\n${wrapped.join("\n")}\n`,
      );
      const assText = wrapped.map(escapeAssText).join("\\N");
      assLines.push(
        `Dialogue: 0,${formatTimestampAss(segStart)},${formatTimestampAss(segEnd)},Caption,,0,0,0,,${assText}`,
      );
      subtitleIndex += 1;
      segStart = segEnd;
    });

    transcriptLines.push(
      `[${formatMmSs(cueStart)} - ${formatMmSs(cueEnd)}] (${cue.id}) ${cue.narration}`,
    );
  });

  return {
    srt: srtBlocks.join("\n"),
    vtt: vttBlocks.join("\n"),
    ass: assLines.join("\n") + "\n",
    transcript: transcriptLines.join("\n") + "\n",
  };
}

function extractPcmData(wavBuffer) {
  if (
    wavBuffer.length < 44 ||
    wavBuffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    wavBuffer.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error("Expected PCM WAV file when assembling narration track.");
  }
  let offset = 12;
  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      return wavBuffer.subarray(
        dataStart,
        Math.min(wavBuffer.length, dataStart + chunkSize),
      );
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  throw new Error("WAV file missing data chunk.");
}

function buildWavHeader(
  dataBytes,
  sampleRate = 48000,
  channels = 1,
  bitsPerSample = 16,
) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, 4, "ascii");
  header.write("fmt ", 12, 4, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, 4, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function assembleSequentialNarrationWav(
  cues,
  targetDurationSeconds,
  outWavPath,
) {
  const sampleRate = 48000;
  const bytesPerSample = 2;
  const totalSamples = Math.max(
    1,
    Math.ceil(targetDurationSeconds * sampleRate),
  );
  const mixed = Buffer.alloc(totalSamples * bytesPerSample);

  for (const cue of cues) {
    const pcm = extractPcmData(await readFile(cue.wav));
    const startSample = Math.max(0, Math.round(cue.start_seconds * sampleRate));
    const cueSamples = Math.floor(pcm.length / bytesPerSample);
    for (let i = 0; i < cueSamples; i++) {
      const destIndex = startSample + i;
      if (destIndex >= totalSamples) break;
      const destOffset = destIndex * bytesPerSample;
      const sum =
        mixed.readInt16LE(destOffset) + pcm.readInt16LE(i * bytesPerSample);
      const clamped = Math.max(-32768, Math.min(32767, sum));
      mixed.writeInt16LE(clamped, destOffset);
    }
  }

  const header = buildWavHeader(mixed.length, sampleRate, 1, 16);
  await writeFile(outWavPath, Buffer.concat([header, mixed]));
  return outWavPath;
}

function probeDurationSeconds(mediaPath) {
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      mediaPath,
    ],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function composeFinalVideo({
  rawVideoPath,
  cues,
  timelineDuration = 0,
  assPath,
  outDir,
  outputMp4Path,
  width,
  height,
  fps,
}) {
  if (!cues || cues.length === 0) {
    throw new Error("Cannot compose video with zero narration cues.");
  }

  const rawDuration = probeDurationSeconds(rawVideoPath);
  const maxCueEnd = Math.max(
    Number(timelineDuration || 0),
    ...cues.map((cue) => Number(cue.end_seconds || 0)),
  );
  const effectiveRawDuration = rawDuration > 0 ? rawDuration : maxCueEnd;
  const maxAudioEnd = Math.max(
    ...cues.map((cue) => cue.start_seconds + cue.audio_duration_seconds),
  );
  const targetDuration = Math.max(effectiveRawDuration, maxAudioEnd + 0.5);
  const padVideoSeconds = Math.max(0, targetDuration - effectiveRawDuration);

  const assembledWavPath = path.join(outDir, "narration-track.wav");
  await assembleSequentialNarrationWav(cues, targetDuration, assembledWavPath);

  const videoFilters = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#0d1117`,
    `fps=${fps}`,
  ];
  if (padVideoSeconds > 0.05) {
    videoFilters.push(
      `tpad=stop_mode=clone:stop_duration=${padVideoSeconds.toFixed(3)}`,
    );
  }
  // Execute ffmpeg with cwd = dirname(assPath) and fixed filename so special
  // characters like apostrophes/commas in parent paths cannot break libass syntax.
  videoFilters.push(`ass=${path.basename(assPath)}`, "format=yuv420p");

  const ffmpegArgs = [
    "-y",
    "-loglevel",
    "error",
    "-i",
    path.resolve(rawVideoPath),
    "-i",
    path.resolve(assembledWavPath),
    "-vf",
    videoFilters.join(","),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-t",
    targetDuration.toFixed(3),
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-movflags",
    "+faststart",
    path.resolve(outputMp4Path),
  ];

  execFileSync("ffmpeg", ffmpegArgs, {
    cwd: path.dirname(path.resolve(assPath)),
    stdio: "inherit",
    timeout: 300_000,
  });
}

function probeVideo(mp4Path) {
  const probeRaw = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", mp4Path],
    { encoding: "utf8", timeout: 30_000 },
  );
  const parsed = JSON.parse(probeRaw);
  const videoStream = parsed.streams.find((s) => s.codec_type === "video");
  const audioStream = parsed.streams.find((s) => s.codec_type === "audio");
  if (!videoStream) throw new Error("Rendered MP4 is missing a video stream.");
  if (!audioStream) throw new Error("Rendered MP4 is missing an audio stream.");

  const [num, den] = String(videoStream.avg_frame_rate || "30/1")
    .split("/")
    .map(Number);
  const fps = den ? Math.round((num / den) * 100) / 100 : 30;
  return {
    codec_video: videoStream.codec_name,
    codec_audio: audioStream.codec_name,
    width: Number(videoStream.width),
    height: Number(videoStream.height),
    fps,
    duration_seconds: Math.round(Number(parsed.format.duration) * 100) / 100,
  };
}

function verifyAudibleAudio(mp4Path) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      mp4Path,
      "-vn",
      "-sn",
      "-dn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg volumedetect failed: ${result.stderr || result.error?.message}`,
    );
  }
  const match = (result.stderr || "").match(
    /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/,
  );
  if (!match) {
    throw new Error("Could not measure audio volume on rendered MP4.");
  }
  const meanDb = Number(match[1]);
  if (meanDb <= -65) {
    throw new Error(
      `Rendered MP4 audio appears silent (mean_volume: ${meanDb} dB).`,
    );
  }
  return meanDb;
}

function extractReviewFrames(mp4Path, cues, durationSeconds, framesDir) {
  const frames = [];
  const maxSeek = Math.max(0.05, durationSeconds - 0.15);
  cues.forEach((cue, index) => {
    const cueSpan = Math.max(
      cue.audio_duration_seconds,
      (cue.end_seconds ?? cue.start_seconds) - cue.start_seconds,
    );
    const mid = Math.min(
      maxSeek,
      Math.max(0.05, cue.start_seconds + cueSpan * 0.65),
    );
    const safeToken = sanitizeFilenameToken(cue.id);
    const outFrame = path.join(
      framesDir,
      `cue-${String(index + 1).padStart(2, "0")}-${safeToken}.png`,
    );
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-ss",
        mid.toFixed(3),
        "-i",
        mp4Path,
        "-frames:v",
        "1",
        outFrame,
      ],
      { stdio: "inherit", timeout: 60_000 },
    );
    if (!existsSync(outFrame)) {
      throw new Error(
        `Failed to extract review frame at ${mid.toFixed(2)}s: ${outFrame}`,
      );
    }
    frames.push(outFrame);
  });
  return frames;
}

export function renderPrEvidenceMarkdown(manifest) {
  const lines = [];
  if (manifest.mode === "video") {
    const recordingLink =
      manifest.video.url && manifest.video.url !== "pending-upload"
        ? `[Playable demonstration](${manifest.video.url})`
        : "`pending-upload` (replace with accessible HTTPS recording URL before marking PR ready)";
    lines.push("### Narrated verification", "");
    lines.push(`Recording: ${recordingLink}`);
    lines.push(`Commit: \`${manifest.commit_sha}\``);
    lines.push(
      `Specs: ${manifest.video.width}x${manifest.video.height} @ ${manifest.video.fps} fps (${manifest.video.codec_video}/${manifest.video.codec_audio}, ${manifest.video.duration_seconds}s, TTS: \`${manifest.video.tts_provider}\`)`,
    );
    lines.push("", "### Demonstrated behavior", "");
    lines.push("| Acceptance criterion | Timestamp | Verification |");
    lines.push("| --- | --- | --- |");
    for (const ac of manifest.acceptance_criteria) {
      lines.push(
        `| ${escapeMarkdownTableCell(ac.id)}: ${escapeMarkdownTableCell(ac.description)} | ${formatMmSs(ac.demonstrated_at_seconds ?? 0)} | ${ac.status === "verified" ? "Passed" : escapeMarkdownTableCell(ac.status)} |`,
      );
    }
  } else {
    lines.push(
      `N/A — ${String(manifest.exemption.reason).replaceAll(/[\r\n]+/g, " ")}`,
      "",
    );
    lines.push("### Equivalent verification artifacts", "");
    for (const artifact of manifest.exemption.equivalent_artifacts) {
      lines.push(`- ${artifact}`);
    }
  }

  lines.push("", "### Automated checks", "");
  for (const check of manifest.test_results) {
    lines.push(`- \`${check.command}\` — ${check.status} (${check.summary})`);
  }

  lines.push("", "### Independent engineering review", "");
  lines.push(
    `- **Verdict:** \`${manifest.review_report.verdict}\` (${manifest.review_report.blocking_findings} blocking findings)`,
  );
  lines.push(`- **Reviewers:** ${manifest.review_report.reviewers.join(", ")}`);

  lines.push("", "### Known limitations", "");
  const limitations = manifest.limitations?.length
    ? manifest.limitations
    : ["None identified within the verified scope."];
  for (const item of limitations) {
    lines.push(`- ${item}`);
  }

  const jsonPayload = JSON.stringify(manifest, null, 2);
  const fence = jsonPayload.includes("```") ? "````" : "```";
  lines.push(
    "",
    "<!-- pr-video-evidence:start -->",
    "<details>",
    "<summary>PR Video Evidence Metadata (machine-verified)</summary>",
    "",
    `${fence}json`,
    jsonPayload,
    fence,
    "",
    "</details>",
    "<!-- pr-video-evidence:end -->",
    "",
  );
  return lines.join("\n");
}

function parseCliArgs(argv) {
  let subcommand = "record";
  let rest = argv;
  if (argv[0] && !argv[0].startsWith("--")) {
    subcommand = argv[0];
    rest = argv.slice(1);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      plan: { type: "string" },
      manifest: { type: "string" },
      "out-dir": { type: "string" },
      out: { type: "string" },
      "run-id": { type: "string" },
      "tts-provider": { type: "string" },
      voice: { type: "string" },
      speed: { type: "string" },
      "video-url": { type: "string" },
      "pr-number": { type: "string" },
      "head-sha": { type: "string" },
      repository: { type: "string" },
      branch: { type: "string" },
      reason: { type: "string" },
      artifact: { type: "string", multiple: true, default: [] },
      "auto-download": { type: "boolean", default: true },
      "no-auto-download": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return { subcommand, options: values };
}

function parsePositiveIntOption(raw, flagName) {
  if (raw === undefined) return null;
  if (!/^[1-9][0-9]*$/.test(String(raw).trim())) {
    throw new Error(`${flagName} must be a positive integer (got "${raw}").`);
  }
  return Number(raw);
}

async function runRecord(options) {
  if (!options.plan) {
    throw new Error(
      "Usage: pnpm devx:video-evidence --plan <plan.json> [--out-dir <dir>] [--tts-provider auto|kokoro|openai] [--video-url <https-url>] [--pr-number <N>]",
    );
  }

  for (const bin of ["python3", "ffmpeg", "ffprobe"]) {
    assertBinary(bin);
  }

  const planPath = path.resolve(options.plan);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const width = Number(plan.width ?? 1920);
  const height = Number(plan.height ?? 1080);
  const fps = Number(plan.fps ?? 30);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1280 ||
    height < 720 ||
    width % 2 !== 0 ||
    height % 2 !== 0
  ) {
    throw new Error(
      `Plan width/height must be even integers >= 1280x720 (got ${width}x${height}).`,
    );
  }
  if (!Number.isFinite(fps) || fps < 24) {
    throw new Error(`Plan fps must be >= 24 (got ${fps}).`);
  }

  const commitSha = git(["rev-parse", "HEAD"]);
  const branch = options.branch || git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const repository =
    options.repository || plan.repository || detectRepository();
  const prNumber =
    parsePositiveIntOption(options["pr-number"], "--pr-number") ??
    plan.pr_number ??
    null;

  const runSlug =
    options["run-id"] ||
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${commitSha.slice(0, 8)}`;
  const outDir = path.resolve(
    options["out-dir"] ||
      path.join(repoRoot, ".tmp", "pr-video-evidence", runSlug),
  );
  const audioDir = path.join(outDir, "audio");
  const framesDir = path.join(outDir, "review-frames");
  await mkdir(audioDir, { recursive: true });
  await mkdir(framesDir, { recursive: true });

  const ttsArgs = [
    path.join(scriptDir, "tts.py"),
    "--plan",
    planPath,
    "--out-dir",
    audioDir,
    "--provider",
    options["tts-provider"] || plan.tts_provider || "auto",
    "--voice",
    options.voice || plan.voice || "af_heart",
    "--speed",
    String(options.speed || plan.speed || 1.0),
  ];
  if (options["no-auto-download"]) ttsArgs.push("--no-auto-download");
  execFileSync("python3", ttsArgs, { stdio: "inherit", timeout: 300_000 });

  const ttsManifestPath = path.join(audioDir, "tts-manifest.json");
  const ttsManifest = JSON.parse(await readFile(ttsManifestPath, "utf8"));

  const target = plan.target || "web";
  const captureScript =
    target === "terminal" || target === "cli" || target === "api"
      ? "capture_terminal.py"
      : "capture_browser.py";
  execFileSync(
    "python3",
    [
      path.join(scriptDir, captureScript),
      "--plan",
      planPath,
      "--tts-manifest",
      ttsManifestPath,
      "--out-dir",
      outDir,
    ],
    { stdio: "inherit", timeout: 600_000 },
  );

  const timeline = JSON.parse(
    await readFile(path.join(outDir, "timeline.json"), "utf8"),
  );

  const captions = buildCaptionTracks(timeline.cues);
  const srtPath = path.join(outDir, "captions.srt");
  const vttPath = path.join(outDir, "captions.vtt");
  const assPath = path.join(outDir, "captions.ass");
  const transcriptPath = path.join(outDir, "transcript.txt");
  await Promise.all([
    writeFile(srtPath, captions.srt, "utf8"),
    writeFile(vttPath, captions.vtt, "utf8"),
    writeFile(assPath, captions.ass, "utf8"),
    writeFile(transcriptPath, captions.transcript, "utf8"),
  ]);

  const outputMp4Path = path.join(outDir, "pr-video-evidence.mp4");
  await composeFinalVideo({
    rawVideoPath: timeline.raw_video,
    cues: timeline.cues,
    timelineDuration: timeline.total_duration_seconds,
    assPath,
    outDir,
    outputMp4Path,
    width,
    height,
    fps,
  });

  const probed = probeVideo(outputMp4Path);
  const meanDb = verifyAudibleAudio(outputMp4Path);
  const reviewFrames = extractReviewFrames(
    outputMp4Path,
    timeline.cues,
    probed.duration_seconds,
    framesDir,
  );
  const mp4Sha256 = await sha256File(outputMp4Path);

  const rel = (p) => (p ? path.relative(repoRoot, p) : null);

  const acceptanceCriteria = timeline.cues
    .filter((cue) => cue.acceptance_criterion_id && cue.acceptance_criterion)
    .map((cue) => ({
      id: cue.acceptance_criterion_id,
      description: cue.acceptance_criterion,
      status: "verified",
      demonstrated_at_seconds: cue.start_seconds,
    }));

  const manifest = {
    schema_version: 1,
    mode: "video",
    repository,
    branch,
    commit_sha: commitSha,
    pr_number: prNumber,
    captured_at: new Date().toISOString(),
    target,
    routes: plan.routes || timeline.observed_routes || ["/"],
    environment: plan.environment || {
      isolated: true,
      description:
        "Isolated local application environment with deterministic fixtures.",
    },
    acceptance_criteria:
      acceptanceCriteria.length > 0
        ? acceptanceCriteria
        : plan.acceptance_criteria || [],
    test_results: plan.test_results || [],
    review_report: plan.review_report || {
      independent: false,
      reviewers: [],
      verdict: "no-ship",
      blocking_findings: 1,
    },
    limitations: plan.limitations || [],
    video: {
      url: options["video-url"] || plan.video_url || "pending-upload",
      codec_video: probed.codec_video,
      codec_audio: probed.codec_audio,
      width: probed.width,
      height: probed.height,
      fps: probed.fps,
      duration_seconds: probed.duration_seconds,
      has_audio: true,
      has_captions: true,
      audio_mean_volume_db: meanDb,
      tts_provider: ttsManifest.provider,
      sha256: mp4Sha256,
    },
    artifacts: {
      final_video: rel(outputMp4Path),
      raw_footage: rel(timeline.raw_video),
      transcript: rel(transcriptPath),
      captions_srt: rel(srtPath),
      captions_vtt: rel(vttPath),
      playwright_trace: timeline.playwright_trace
        ? rel(timeline.playwright_trace)
        : null,
      review_frames: reviewFrames.map(rel),
    },
  };

  const manifestPath = path.join(outDir, "evidence.json");
  const prMarkdownPath = path.join(outDir, "pr-evidence.md");
  await writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  await writeFile(prMarkdownPath, renderPrEvidenceMarkdown(manifest), "utf8");

  const validation = validatePrVideoEvidence({
    manifest,
    headSha: commitSha,
    repository,
    branch,
    prNumber,
    allowPendingUrl: manifest.video.url === "pending-upload",
  });

  console.log(`\nNarrated video evidence generated in: ${outDir}`);
  console.log(
    `- Video: ${outputMp4Path} (${probed.width}x${probed.height} @ ${probed.fps}fps, ${probed.codec_video}/${probed.codec_audio}, ${probed.duration_seconds}s, mean audio ${meanDb} dB)`,
  );
  console.log(`- Manifest: ${manifestPath}`);
  console.log(`- PR Markdown: ${prMarkdownPath}`);
  console.log(`- Review frames (${reviewFrames.length}): ${framesDir}`);

  if (!validation.ok) {
    console.error("\nEvidence validation reported blocking items:");
    for (const err of validation.errors) {
      console.error(`- ${err}`);
    }
    process.exitCode = 1;
  }
}

async function runExempt(options) {
  if (!options.reason || options.artifact.length === 0) {
    throw new Error(
      'Usage: pnpm devx:video-evidence exempt --reason "<why video is inapplicable>" --artifact "<verification artifact>" --plan <metadata.json> [--out-dir <dir>]',
    );
  }
  let basePlan = {};
  if (options.plan) {
    const resolvedPlan = path.resolve(options.plan);
    if (!existsSync(resolvedPlan)) {
      throw new Error(`Plan file not found: ${resolvedPlan}`);
    }
    basePlan = JSON.parse(await readFile(resolvedPlan, "utf8"));
  }

  const commitSha = git(["rev-parse", "HEAD"]);
  const branch = options.branch || git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const repository =
    options.repository || basePlan.repository || detectRepository();
  const prNumber =
    parsePositiveIntOption(options["pr-number"], "--pr-number") ??
    basePlan.pr_number ??
    null;

  const outDir = path.resolve(
    options["out-dir"] ||
      path.join(
        repoRoot,
        ".tmp",
        "pr-video-evidence",
        `exempt-${commitSha.slice(0, 8)}`,
      ),
  );
  await mkdir(outDir, { recursive: true });

  const manifest = {
    schema_version: 1,
    mode: "non-demonstrable",
    repository,
    branch,
    commit_sha: commitSha,
    pr_number: prNumber,
    captured_at: new Date().toISOString(),
    target: "non-demonstrable",
    routes: basePlan.routes || ["n/a"],
    environment: basePlan.environment || {
      isolated: true,
      description:
        "Non-demonstrable change verified through automated repository checks.",
    },
    acceptance_criteria: basePlan.acceptance_criteria || [
      {
        id: "AC-1",
        description: options.reason,
        status: "verified",
      },
    ],
    test_results: basePlan.test_results || [],
    review_report: basePlan.review_report || {
      independent: false,
      reviewers: [],
      verdict: "no-ship",
      blocking_findings: 1,
    },
    limitations: basePlan.limitations || [],
    exemption: {
      reason: options.reason,
      equivalent_artifacts: options.artifact,
    },
  };

  const validation = validatePrVideoEvidence({
    manifest,
    headSha: commitSha,
    repository,
    branch,
    prNumber,
  });

  const manifestPath = path.join(outDir, "evidence.json");
  const prMarkdownPath = path.join(outDir, "pr-evidence.md");
  await writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  await writeFile(prMarkdownPath, renderPrEvidenceMarkdown(manifest), "utf8");

  if (!validation.ok) {
    console.error("Exemption manifest failed validation:");
    for (const err of validation.errors) {
      console.error(`- ${err}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validated exemption manifest written to ${manifestPath}`);
}

async function runRenderPrBlock(options) {
  if (!options.manifest) {
    throw new Error(
      "Usage: pnpm devx:video-evidence render-pr-block --manifest <evidence.json> [--video-url <https-url>] [--pr-number <N>] [--out <file>]",
    );
  }
  const manifestPath = path.resolve(options.manifest);
  const original = JSON.parse(await readFile(manifestPath, "utf8"));
  const candidate = structuredClone(original);

  if (options["video-url"] && candidate.video) {
    candidate.video.url = options["video-url"];
  }
  const prNumber = parsePositiveIntOption(options["pr-number"], "--pr-number");
  if (prNumber !== null) {
    candidate.pr_number = prNumber;
  }

  // Never mutate candidate.commit_sha; compare against actual HEAD (or explicit expected --head-sha).
  const expectedHeadSha = options["head-sha"] || git(["rev-parse", "HEAD"]);
  const expectedBranch =
    options.branch || git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const expectedRepository = options.repository || detectRepository();
  const renderedMarkdown = renderPrEvidenceMarkdown(candidate);
  const syntheticPrBody = `## Demo\n\n${renderedMarkdown}`;

  const validation = validatePrVideoEvidence({
    prBody: syntheticPrBody,
    headSha: expectedHeadSha,
    repository: expectedRepository,
    branch: expectedBranch,
    prNumber: candidate.pr_number,
  });
  if (!validation.ok) {
    console.error("Updated manifest failed validation (files left unchanged):");
    for (const err of validation.errors) console.error(`- ${err}`);
    process.exitCode = 1;
    return;
  }

  await writeFile(
    manifestPath,
    JSON.stringify(candidate, null, 2) + "\n",
    "utf8",
  );
  const outFile = options.out
    ? path.resolve(options.out)
    : path.join(path.dirname(manifestPath), "pr-evidence.md");
  await writeFile(outFile, renderedMarkdown, "utf8");
  console.log(`Updated PR evidence block written to ${outFile}`);
}

async function main() {
  const { subcommand, options } = parseCliArgs(process.argv.slice(2));
  if (subcommand === "record") {
    await runRecord(options);
  } else if (subcommand === "exempt") {
    await runExempt(options);
  } else if (subcommand === "render-pr-block") {
    await runRenderPrBlock(options);
  } else {
    throw new Error(
      `Unknown subcommand "${subcommand}". Expected record, exempt, or render-pr-block.`,
    );
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
