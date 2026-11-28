import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderPrEvidenceMarkdown } from "./pr-video-evidence/cli.mjs";
import { validatePrVideoEvidence } from "./verify-pr-video-evidence.mjs";

const HEAD_SHA = "a".repeat(40);
const VIDEO_SHA256 = "b".repeat(64);
const RECORDING_URL =
  "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";

const prDescriptionWorkflow = readFileSync(
  new URL("../.github/workflows/pr-description.yml", import.meta.url),
  "utf8",
);
const prDescriptionScript = prDescriptionWorkflow.match(
  /node <<'NODE'\n([\s\S]*?)\n\s+NODE/,
)?.[1];
assert.ok(prDescriptionScript, "pr-description.yml must embed its script");

function makeValidManifest(overrides = {}) {
  return {
    schema_version: 1,
    mode: "video",
    repository: "PlaybookMediaLLC/shots-founder-hub",
    branch: "chore/pr-video-evidence",
    commit_sha: HEAD_SHA,
    pr_number: 39,
    captured_at: "2026-11-28T09:30:00Z",
    target: "web",
    routes: ["/changelog/"],
    environment: {
      isolated: true,
      description:
        "Isolated local @anlg/web Vite server on ephemeral port with deterministic changelog fixtures.",
    },
    acceptance_criteria: [
      {
        id: "AC-1",
        description:
          "Filter changelog entries by platform and open release detail route",
        status: "verified",
        demonstrated_at_seconds: 6.2,
      },
    ],
    test_results: [
      {
        command: "node --test scripts/verify-pr-video-evidence.test.mjs",
        status: "passed",
        summary: "All regression checks passed",
      },
    ],
    review_report: {
      independent: true,
      reviewers: ["structure", "perf", "chaos", "qa", "lean"],
      verdict: "ship",
      blocking_findings: 0,
    },
    video: {
      url: RECORDING_URL,
      codec_video: "h264",
      codec_audio: "aac",
      width: 1920,
      height: 1080,
      fps: 30,
      duration_seconds: 42.5,
      has_audio: true,
      has_captions: true,
      tts_provider: "kokoro-onnx",
      sha256: VIDEO_SHA256,
    },
    artifacts: {
      raw_footage: ".tmp/pr-video-evidence/run/raw-capture.webm",
      transcript: ".tmp/pr-video-evidence/run/transcript.txt",
      captions_srt: ".tmp/pr-video-evidence/run/captions.srt",
      captions_vtt: ".tmp/pr-video-evidence/run/captions.vtt",
      playwright_trace: ".tmp/pr-video-evidence/run/trace.zip",
    },
    ...overrides,
  };
}

function wrapPrBody(manifest, demoLine) {
  const demo = demoLine ?? `Recording: ${RECORDING_URL}`;
  return [
    "## Summary",
    "",
    "**Intent:** Enforce narrated video verification evidence on every pull request.",
    "",
    "## Demo",
    "",
    demo,
    "",
    "## Verification",
    "",
    "<!-- pr-video-evidence:start -->",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "<!-- pr-video-evidence:end -->",
  ].join("\n");
}

function runPrDescriptionCheck(prBody) {
  return spawnSync(process.execPath, ["-e", prDescriptionScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      PR_AUTHOR_ASSOCIATION: "NONE",
      PR_AUTHOR_TYPE: "User",
      PR_TITLE: "Enforce narrated video evidence on pull requests",
      PR_BODY: prBody,
    },
  });
}

test("accepts fresh narrated video evidence and allows tracked product/test media assets", () => {
  const manifest = makeValidManifest();
  const result = validatePrVideoEvidence({
    prBody: wrapPrBody(manifest),
    headSha: HEAD_SHA,
    repository: "PlaybookMediaLLC/shots-founder-hub",
    branch: "chore/pr-video-evidence",
    prNumber: 39,
    changedFiles: [
      "AGENTS.md",
      "apps/desktop/public/assets/onboarding-video.mp4",
      "crates/data/src/english_1/audio.webm",
      "crates/aec/data/inputs/anarlog_mic.wav",
    ],
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("generated video and non-demonstrable PR blocks pass both pr-video-evidence and pr-description checks", () => {
  const videoManifest = makeValidManifest({
    test_results: [
      {
        command: "node --test scripts/verify-pr-video-evidence.test.mjs",
        status: "passed",
        summary: "Passed even with ```triple backticks``` inside summary",
      },
    ],
  });
  const videoBody = [
    "## Summary",
    "",
    "**Intent:** Verify that quoted `<!-- pr-video-evidence:start -->` mentions in Summary do not break parsing.",
    "",
    "## Demo",
    "",
    renderPrEvidenceMarkdown(videoManifest),
  ].join("\n");

  const videoCheck = validatePrVideoEvidence({
    prBody: videoBody,
    headSha: HEAD_SHA,
    repository: "PlaybookMediaLLC/shots-founder-hub",
    branch: "chore/pr-video-evidence",
    prNumber: 39,
  });
  assert.equal(videoCheck.ok, true, videoCheck.errors.join("\n"));
  assert.equal(runPrDescriptionCheck(videoBody).status, 0);

  const exemptManifest = makeValidManifest({
    mode: "non-demonstrable",
    target: "non-demonstrable",
    routes: ["docs/architecture"],
    video: undefined,
    artifacts: undefined,
    review_report: {
      independent: false,
      exception_reason: "Documentation-only edit with zero executable logic.",
      reviewers: ["self (docs-only exception)"],
      verdict: "ship",
      blocking_findings: 0,
    },
    acceptance_criteria: [
      {
        id: "AC-1",
        description:
          "Documentation wording updated without runtime behavior changes",
        status: "verified",
      },
    ],
    exemption: {
      reason:
        "Documentation-only policy update with no executable UI, CLI, or API surface.",
      equivalent_artifacts: [
        "dprint check passed",
        "license boundary check passed",
      ],
    },
  });
  const exemptBody = [
    "## Summary",
    "",
    "**Intent:** Update repository documentation without runtime behavior changes.",
    "",
    "## Demo",
    "",
    renderPrEvidenceMarkdown(exemptManifest),
  ].join("\n");

  const exemptCheck = validatePrVideoEvidence({
    prBody: exemptBody,
    headSha: HEAD_SHA,
    repository: "PlaybookMediaLLC/shots-founder-hub",
    branch: "chore/pr-video-evidence",
    prNumber: 39,
  });
  assert.equal(exemptCheck.ok, true, exemptCheck.errors.join("\n"));
  const descResult = runPrDescriptionCheck(exemptBody);
  assert.equal(descResult.status, 0, descResult.stderr);
});

test("rejects stale commits and repository, branch, or PR number mismatches", () => {
  const manifest = makeValidManifest({
    commit_sha: "c".repeat(40),
    repository: "other/repo",
    branch: "other-branch",
    pr_number: 99,
  });
  const result = validatePrVideoEvidence({
    prBody: wrapPrBody(manifest),
    headSha: HEAD_SHA,
    repository: "PlaybookMediaLLC/shots-founder-hub",
    branch: "chore/pr-video-evidence",
    prNumber: 39,
  });
  assert.equal(result.ok, false);
  const combined = result.errors.join("\n");
  assert.match(combined, /Stale evidence/);
  assert.match(combined, /repository mismatch/);
  assert.match(combined, /branch mismatch/);
  assert.match(combined, /pr_number mismatch/);
});

test("rejects spoofed, hidden, mismatched, or localhost Demo links and malformed metadata blocks", () => {
  const manifest = makeValidManifest();
  const metadataOnlyDemo = [
    "## Summary",
    "",
    "**Intent:** Enforce visible recording link in Demo.",
    "",
    "## Demo",
    "",
    "No visible recording link here.",
    "",
    "<!-- pr-video-evidence:start -->",
    "<details><summary>meta</summary>",
    "",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "</details>",
    "<!-- pr-video-evidence:end -->",
  ].join("\n");

  const cases = [
    wrapPrBody(manifest, `\`\`\`text\n${RECORDING_URL}\n\`\`\``),
    wrapPrBody(manifest, `    ${RECORDING_URL}`),
    wrapPrBody(manifest, "https://localhost:3000/demo.mp4"),
    wrapPrBody(manifest, "https://example.com/unrelated-link"),
    metadataOnlyDemo,
    "## Summary\n\n```md\n## Demo\nhttps://example.com/spoof\n```\n\n## Demo\n\n<!-- pr-video-evidence:start -->\n```json\n" +
      JSON.stringify(manifest) +
      "\n```\n<!-- pr-video-evidence:end -->",
    "## Summary\n\nNo metadata block at all.",
    "## Demo\n\n<!-- pr-video-evidence:start -->\n```json\n{broken\n```\n<!-- pr-video-evidence:end -->",
    "## Demo\n\n<!-- pr-video-evidence:start -->\n```json\n[]\n```\n<!-- pr-video-evidence:end -->",
  ];

  for (const body of cases) {
    const result = validatePrVideoEvidence({
      prBody: body,
      headSha: HEAD_SHA,
      repository: "PlaybookMediaLLC/shots-founder-hub",
      branch: "chore/pr-video-evidence",
      prNumber: 39,
    });
    assert.equal(result.ok, false, `Expected rejection for:\n${body}`);
  }
});

test("rejects invalid video specs, IPv6/loopback URLs, invalid dates, out-of-range timestamps, and failed gates", () => {
  const manifest = makeValidManifest({
    captured_at: "2026-02-31T00:00:00Z",
    acceptance_criteria: [
      {
        id: "AC-1",
        description: "Criterion beyond video duration",
        status: "unverified",
        demonstrated_at_seconds: 999,
      },
    ],
    test_results: [
      { command: "pnpm test", status: "failed", summary: "1 failure" },
    ],
    review_report: {
      independent: false,
      reviewers: [],
      verdict: "no-ship",
      blocking_findings: 2,
    },
    video: {
      ...makeValidManifest().video,
      url: "https://[::1]/demo.mp4",
      codec_video: "vp9",
      codec_audio: "opus",
      width: 1920.5,
      has_audio: false,
      has_captions: false,
    },
  });
  const result = validatePrVideoEvidence({
    prBody: wrapPrBody(manifest, "https://[::1]/demo.mp4"),
    headSha: HEAD_SHA,
    repository: "PlaybookMediaLLC/shots-founder-hub",
    branch: "chore/pr-video-evidence",
  });
  assert.equal(result.ok, false);
  const combined = result.errors.join("\n");
  assert.match(combined, /captured_at/);
  assert.match(combined, /is not verified/);
  assert.match(combined, /exceeds video\.duration_seconds/);
  assert.match(combined, /did not pass/);
  assert.match(combined, /independent must be true/);
  assert.match(combined, /review_report\.reviewers/);
  assert.match(combined, /verdict must be "ship"/);
  assert.match(combined, /blocking_findings must be 0/);
  assert.match(combined, /accessible HTTPS URL/);
  assert.match(combined, /integer dimensions/);
  assert.match(combined, /codec_video must be "h264"/);
  assert.match(combined, /codec_audio must be "aac"/);
  assert.match(combined, /has_audio must be true/);
  assert.match(combined, /has_captions must be true/);
});

test("enforces target-specific trace rules, pending-upload gating, and desktop capture_log support", () => {
  const webMissingTrace = makeValidManifest({
    artifacts: {
      raw_footage: ".tmp/pr-video-evidence/run/raw.webm",
      transcript: ".tmp/pr-video-evidence/run/transcript.txt",
      captions_srt: ".tmp/pr-video-evidence/run/captions.srt",
      captions_vtt: ".tmp/pr-video-evidence/run/captions.vtt",
    },
  });
  assert.equal(
    validatePrVideoEvidence({ manifest: webMissingTrace, headSha: HEAD_SHA })
      .ok,
    false,
  );

  const desktopNativeLog = makeValidManifest({
    target: "desktop",
    artifacts: {
      raw_footage: ".tmp/pr-video-evidence/run/raw.mp4",
      transcript: ".tmp/pr-video-evidence/run/transcript.txt",
      captions_srt: ".tmp/pr-video-evidence/run/captions.srt",
      captions_vtt: ".tmp/pr-video-evidence/run/captions.vtt",
      capture_log: ".tmp/pr-video-evidence/run/wdio.log",
    },
  });
  assert.equal(
    validatePrVideoEvidence({ manifest: desktopNativeLog, headSha: HEAD_SHA })
      .ok,
    true,
  );

  const pendingManifest = makeValidManifest({
    video: { ...makeValidManifest().video, url: "pending-upload" },
  });
  assert.equal(
    validatePrVideoEvidence({ manifest: pendingManifest, headSha: HEAD_SHA })
      .ok,
    false,
  );
  assert.equal(
    validatePrVideoEvidence({
      prBody: `## Demo\n\n${renderPrEvidenceMarkdown(pendingManifest)}`,
      headSha: HEAD_SHA,
      allowPendingUrl: true,
    }).ok,
    true,
  );

  const invalidExempt = makeValidManifest({
    mode: "non-demonstrable",
    target: "non-demonstrable",
    video: undefined,
    artifacts: undefined,
    review_report: {
      independent: false,
      reviewers: ["self"],
      verdict: "ship",
      blocking_findings: 0,
    },
    acceptance_criteria: [
      { id: "AC-1", description: "Doc change", status: "verified" },
    ],
    exemption: {
      reason: "too short",
      equivalent_artifacts: [],
    },
  });
  const exemptFailures = validatePrVideoEvidence({
    prBody: wrapPrBody(invalidExempt, "Skipped without N/A prefix"),
    headSha: HEAD_SHA,
    repository: "PlaybookMediaLLC/shots-founder-hub",
    branch: "chore/pr-video-evidence",
    prNumber: 39,
  });
  assert.equal(exemptFailures.ok, false);
  const exemptMsg = exemptFailures.errors.join("\n");
  assert.match(exemptMsg, /exemption\.reason/);
  assert.match(exemptMsg, /exemption\.equivalent_artifacts/);
  assert.match(exemptMsg, /independent must be true/);
  assert.match(exemptMsg, /N\/A — <reason>/);
});

test("rejects committed binary recording artifacts and leaked credentials", () => {
  const manifest = makeValidManifest({
    environment: {
      isolated: true,
      description: "Ran with token ghp_1234567890abcdefghij1234567890",
    },
  });
  const result = validatePrVideoEvidence({
    prBody: wrapPrBody(manifest),
    headSha: HEAD_SHA,
    repository: "PlaybookMediaLLC/shots-founder-hub",
    branch: "chore/pr-video-evidence",
    changedFiles: ["docs/demo.mp4", ".tmp/pr-video-evidence/run/trace.zip"],
  });
  assert.equal(result.ok, false);
  const combined = result.errors.join("\n");
  assert.match(combined, /docs\/demo\.mp4/);
  assert.match(combined, /\.tmp\/pr-video-evidence\/run\/trace\.zip/);
  assert.match(combined, /Secret hygiene violation/);
});

test("render-pr-block keeps commit_sha immutable and validates before writing, round-tripping through CLI", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pr-evidence-cli-"));
  try {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const staleManifest = makeValidManifest({
      commit_sha: "d".repeat(40),
      branch,
      video: { ...makeValidManifest().video, url: "pending-upload" },
    });
    const stalePath = path.join(tmpDir, "stale.json");
    const staleRaw = JSON.stringify(staleManifest, null, 2) + "\n";
    await writeFile(stalePath, staleRaw, "utf8");

    const staleRun = spawnSync(
      process.execPath,
      [
        "scripts/pr-video-evidence/cli.mjs",
        "render-pr-block",
        "--manifest",
        stalePath,
        "--video-url",
        RECORDING_URL,
        "--repository",
        "PlaybookMediaLLC/shots-founder-hub",
        "--branch",
        branch,
      ],
      { encoding: "utf8" },
    );
    assert.equal(staleRun.status, 1);
    assert.equal(await readFile(stalePath, "utf8"), staleRaw);

    const freshManifest = makeValidManifest({
      commit_sha: headSha,
      branch,
      pr_number: null,
      video: { ...makeValidManifest().video, url: "pending-upload" },
    });
    const freshPath = path.join(tmpDir, "evidence.json");
    const prMdPath = path.join(tmpDir, "pr-evidence.md");
    await writeFile(freshPath, JSON.stringify(freshManifest, null, 2), "utf8");

    const okRun = spawnSync(
      process.execPath,
      [
        "scripts/pr-video-evidence/cli.mjs",
        "render-pr-block",
        "--manifest",
        freshPath,
        "--video-url",
        RECORDING_URL,
        "--pr-number",
        "42",
        "--repository",
        "PlaybookMediaLLC/shots-founder-hub",
        "--branch",
        branch,
        "--out",
        prMdPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(okRun.status, 0, okRun.stderr);

    const eventPath = path.join(tmpDir, "event.json");
    const changedPath = path.join(tmpDir, "changed.txt");
    await writeFile(
      changedPath,
      "AGENTS.md\nscripts/verify-pr-video-evidence.mjs\n",
    );
    await writeFile(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 42,
          draft: false,
          user: { type: "User" },
          body: `## Summary\n\n**Intent:** Verify end-to-end evidence validation.\n\n## Demo\n\n${await readFile(prMdPath, "utf8")}`,
          head: {
            sha: headSha,
            ref: branch,
            repo: { full_name: "PlaybookMediaLLC/shots-founder-hub" },
          },
        },
      }),
    );

    const verifyRun = spawnSync(
      process.execPath,
      [
        "scripts/verify-pr-video-evidence.mjs",
        "--github-event-path",
        eventPath,
        "--repository",
        "PlaybookMediaLLC/shots-founder-hub",
        "--changed-files-file",
        changedPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(verifyRun.status, 0, verifyRun.stderr);

    // Draft PR with no metadata block stays pending (exit 0), whereas malformed metadata fails (exit 1).
    const draftPendingEvent = path.join(tmpDir, "draft-pending.json");
    await writeFile(
      draftPendingEvent,
      JSON.stringify({
        pull_request: {
          number: 43,
          draft: true,
          user: { type: "User" },
          body: "## Summary\n\n**Intent:** Work in progress.",
          head: {
            sha: headSha,
            ref: branch,
            repo: { full_name: "PlaybookMediaLLC/shots-founder-hub" },
          },
        },
      }),
    );
    assert.equal(
      spawnSync(
        process.execPath,
        [
          "scripts/verify-pr-video-evidence.mjs",
          "--github-event-path",
          draftPendingEvent,
          "--repository",
          "PlaybookMediaLLC/shots-founder-hub",
          "--changed-files-file",
          changedPath,
        ],
        { encoding: "utf8" },
      ).status,
      0,
    );

    const draftMalformedEvent = path.join(tmpDir, "draft-malformed.json");
    await writeFile(
      draftMalformedEvent,
      JSON.stringify({
        pull_request: {
          number: 44,
          draft: true,
          user: { type: "User" },
          body: "## Demo\n\n<!-- pr-video-evidence:start -->\n```json\n{broken\n```\n<!-- pr-video-evidence:end -->",
          head: {
            sha: headSha,
            ref: branch,
            repo: { full_name: "PlaybookMediaLLC/shots-founder-hub" },
          },
        },
      }),
    );
    assert.equal(
      spawnSync(
        process.execPath,
        [
          "scripts/verify-pr-video-evidence.mjs",
          "--github-event-path",
          draftMalformedEvent,
          "--repository",
          "PlaybookMediaLLC/shots-founder-hub",
          "--changed-files-file",
          changedPath,
        ],
        { encoding: "utf8" },
      ).status,
      1,
    );

    // chore/linux-packages-* skip is strictly scoped to Linux packaging directories.
    const releaseEvent = path.join(tmpDir, "release.json");
    await writeFile(
      releaseEvent,
      JSON.stringify({
        pull_request: {
          number: 45,
          draft: false,
          user: { type: "User" },
          body: "Update Linux packaging for v1.5.2",
          head: {
            sha: headSha,
            ref: "chore/linux-packages-1.5.2",
            repo: { full_name: "PlaybookMediaLLC/shots-founder-hub" },
          },
        },
      }),
    );
    const pkgOnlyChanged = path.join(tmpDir, "pkg-only.txt");
    await writeFile(
      pkgOnlyChanged,
      "packaging/aur/shots-founder-hub-bin/PKGBUILD\napps/web/public/apt/Release\n",
    );
    assert.equal(
      spawnSync(
        process.execPath,
        [
          "scripts/verify-pr-video-evidence.mjs",
          "--github-event-path",
          releaseEvent,
          "--repository",
          "PlaybookMediaLLC/shots-founder-hub",
          "--changed-files-file",
          pkgOnlyChanged,
        ],
        { encoding: "utf8" },
      ).status,
      0,
    );
    assert.equal(
      spawnSync(
        process.execPath,
        [
          "scripts/verify-pr-video-evidence.mjs",
          "--github-event-path",
          releaseEvent,
          "--repository",
          "PlaybookMediaLLC/shots-founder-hub",
          "--changed-files-file",
          changedPath,
        ],
        { encoding: "utf8" },
      ).status,
      1,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
