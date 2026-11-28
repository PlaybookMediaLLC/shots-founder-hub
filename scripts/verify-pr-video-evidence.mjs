import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SHA40_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const VALID_TARGETS = new Set([
  "web",
  "desktop",
  "cli",
  "api",
  "terminal",
  "mobile",
  "non-demonstrable",
]);
const VIDEO_FILE_RE = /\.(?:mp4|mov|webm|mkv|avi|m4v)$/i;
const TRACKED_MEDIA_ALLOWLIST_RE =
  /^(?:apps\/[^/]+\/public\/|crates\/data\/src\/)/i;
const EVIDENCE_BINARY_RE =
  /(?:^|\/)(?:trace\.zip|.*\.(?:wav|mp3|aac|flac|ogg))$/i;
const EVIDENCE_PATH_HINT_RE =
  /(?:^|\/)(?:\.tmp|pr-video-evidence|pr-evidence|playwright-report|test-results)\//i;
const AUTOMATED_RELEASE_BRANCH_RE = /^chore\/linux-packages-/;
const AUTOMATED_RELEASE_ALLOWED_PATH_RE =
  /^(?:packaging\/aur\/shots-founder-hub-bin\/|apps\/web\/public\/apt\/)/;

export const SECRET_PATTERNS = [
  {
    label: "GitHub token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    label: "API secret key",
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,})\b/,
  },
  { label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    label: "Private key material",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  },
  { label: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  {
    label: "JWT credential",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  const trimmed = value.trim();
  const match = trimmed.match(ISO_TIMESTAMP_RE);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(trimmed));
}

export function isValidHttpsUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0" ||
      host.startsWith("127.") ||
      host === "::1" ||
      host === "::" ||
      host.startsWith("::ffff:127.") ||
      host.startsWith("::ffff:7f")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function detectBinaryArtifacts(changedFiles = []) {
  const violations = [];
  for (const rawFile of changedFiles) {
    const file = String(rawFile || "")
      .trim()
      .replaceAll("\\", "/");
    if (!file) continue;
    if (VIDEO_FILE_RE.test(file) && !TRACKED_MEDIA_ALLOWLIST_RE.test(file)) {
      violations.push(file);
      continue;
    }
    if (
      EVIDENCE_BINARY_RE.test(file) &&
      (EVIDENCE_PATH_HINT_RE.test(file) || /(?:^|\/)trace\.zip$/i.test(file))
    ) {
      violations.push(file);
    }
  }
  return violations;
}

export function detectSecrets(value, location = "manifest", findings = []) {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(value)) {
        findings.push(`${pattern.label} detected in ${location}`);
      }
    }
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      detectSecrets(item, `${location}[${index}]`, findings),
    );
    return findings;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      detectSecrets(nested, `${location}.${key}`, findings);
    }
  }
  return findings;
}

function stripEvidenceRegion(markdown) {
  return markdown.replace(
    /^[ \t]*<!--\s*pr-video-evidence:start\s*-->[\s\S]*?^[ \t]*<!--\s*pr-video-evidence:end\s*-->[ \t]*$/gim,
    "",
  );
}

function stripHtmlCommentsOutsideCode(markdown) {
  let inComment = false;
  let fenceMarker = "";

  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const leadingMarker = line.match(/^ {0,3}(`+|~+)/)?.[1] || "";
      if (!inComment && leadingMarker.length >= 3) {
        if (!fenceMarker) {
          fenceMarker = leadingMarker;
        } else if (
          leadingMarker[0] === fenceMarker[0] &&
          leadingMarker.length >= fenceMarker.length &&
          line.trimStart().slice(leadingMarker.length).trim() === ""
        ) {
          fenceMarker = "";
        }
        return line;
      }

      if (fenceMarker) return line;

      let visible = "";
      let inlineTicks = 0;
      for (let index = 0; index < line.length; ) {
        if (inComment) {
          const commentEnd = line.indexOf("-->", index);
          if (commentEnd === -1) return visible;
          inComment = false;
          index = commentEnd + 3;
          continue;
        }

        if (line[index] === "`") {
          let tickEnd = index + 1;
          while (line[tickEnd] === "`") tickEnd++;
          const tickCount = tickEnd - index;
          if (inlineTicks === 0) {
            const closingTicks = new RegExp(
              "(^|[^`])" + "`".repeat(tickCount) + "(?!`)",
            );
            if (closingTicks.test(line.slice(tickEnd))) inlineTicks = tickCount;
          } else if (tickCount === inlineTicks) {
            inlineTicks = 0;
          }
          visible += line.slice(index, tickEnd);
          index = tickEnd;
          continue;
        }

        if (
          inlineTicks === 0 &&
          line[index - 1] !== "\\" &&
          line.startsWith("<!--", index)
        ) {
          inComment = true;
          index += 4;
          continue;
        }

        visible += line[index];
        index++;
      }
      return visible;
    })
    .join("\n");
}

function markCodeLines(markdown) {
  let fenceMarker = "";

  return markdown.split(/\r?\n/).map((text) => {
    const leadingMarker = text.match(/^ {0,3}(`+|~+)/)?.[1] || "";
    if (!fenceMarker && leadingMarker.length >= 3) {
      fenceMarker = leadingMarker;
      return { text, isCode: true };
    }

    if (fenceMarker) {
      if (
        leadingMarker[0] === fenceMarker[0] &&
        leadingMarker.length >= fenceMarker.length &&
        text.trimStart().slice(leadingMarker.length).trim() === ""
      ) {
        fenceMarker = "";
      }
      return { text, isCode: true };
    }

    return { text, isCode: /^(?: {4}|\t)/.test(text) };
  });
}

function stripInlineCodeSpans(line) {
  let output = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let end = i + 1;
      while (line[end] === "`") end++;
      const ticks = "`".repeat(end - i);
      const closeIndex = line.indexOf(ticks, end);
      if (closeIndex !== -1) {
        i = closeIndex + ticks.length;
        continue;
      }
    }
    output += line[i];
    i++;
  }
  return output;
}

export function extractEvidenceBlock(markdown) {
  if (typeof markdown !== "string") {
    return { manifest: null, error: "PR description is empty." };
  }

  // Locate start/end comment markers strictly on their own non-code lines so
  // inline mentions or code-block examples in Summary cannot hijack parsing.
  const lines = markdown.split(/\r?\n/);
  let fenceMarker = "";
  let blockStart = -1;
  let lastBlockLines = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const leadingMarker = line.match(/^ {0,3}(`+|~+)/)?.[1] || "";

    if (blockStart === -1 && leadingMarker.length >= 3) {
      if (!fenceMarker) {
        fenceMarker = leadingMarker;
      } else if (
        leadingMarker[0] === fenceMarker[0] &&
        leadingMarker.length >= fenceMarker.length &&
        line.trimStart().slice(leadingMarker.length).trim() === ""
      ) {
        fenceMarker = "";
      }
      continue;
    }

    if (blockStart === -1 && fenceMarker) {
      continue;
    }

    if (
      blockStart === -1 &&
      /^<!--\s*pr-video-evidence:start\s*-->$/i.test(trimmed)
    ) {
      blockStart = i + 1;
      continue;
    }

    if (
      blockStart !== -1 &&
      /^<!--\s*pr-video-evidence:end\s*-->$/i.test(trimmed)
    ) {
      lastBlockLines = lines.slice(blockStart, i);
      blockStart = -1;
    }
  }

  if (!lastBlockLines) {
    return {
      manifest: null,
      missingBlock: true,
      error:
        "Missing pr-video-evidence metadata block (<!-- pr-video-evidence:start --> ... <!-- pr-video-evidence:end -->). Generate it with `pnpm devx:video-evidence`.",
    };
  }

  // Extract fenced JSON block using line-anchored matching so triple backticks
  // inside JSON string values never truncate the payload.
  let openFence = "";
  let jsonLines = null;
  let collecting = false;
  for (const line of lastBlockLines) {
    if (!collecting) {
      const openMatch = line.match(/^ {0,3}(`{3,})json[ \t]*$/i);
      if (openMatch) {
        openFence = openMatch[1];
        jsonLines = [];
        collecting = true;
      }
    } else {
      const closeMatch = line.match(/^ {0,3}(`{3,})[ \t]*$/);
      if (closeMatch && closeMatch[1].length >= openFence.length) {
        collecting = false;
        break;
      }
      jsonLines.push(line);
    }
  }

  const candidate = jsonLines
    ? jsonLines.join("\n").trim()
    : lastBlockLines
        .join("\n")
        .replace(/<\/?details[^>]*>/gi, "")
        .replace(/<summary[^>]*>[\s\S]*?<\/summary>/gi, "")
        .trim();

  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        manifest: null,
        missingBlock: false,
        error: "pr-video-evidence metadata block must contain a JSON object.",
      };
    }
    return { manifest: parsed, missingBlock: false, error: null };
  } catch (error) {
    return {
      manifest: null,
      missingBlock: false,
      error: `Invalid JSON in pr-video-evidence metadata block: ${error.message}`,
    };
  }
}

export function extractDemoSection(markdown) {
  const withoutEvidence = stripEvidenceRegion(markdown);
  const visibleLines = markCodeLines(
    stripHtmlCommentsOutsideCode(withoutEvidence),
  );
  const demoIndex = visibleLines.findIndex(
    (line) => !line.isCode && /^##\s+demo\s*$/i.test(line.text.trim()),
  );
  if (demoIndex === -1) return "";
  let endIndex = visibleLines.length;
  for (let i = demoIndex + 1; i < visibleLines.length; i++) {
    if (!visibleLines[i].isCode && /^##\s+/.test(visibleLines[i].text.trim())) {
      endIndex = i;
      break;
    }
  }
  return visibleLines
    .slice(demoIndex + 1, endIndex)
    .filter((line) => !line.isCode)
    .map((line) => stripInlineCodeSpans(line.text))
    .join("\n")
    .trim();
}

function extractHttpsUrls(text) {
  const matches = text.match(/\bhttps:\/\/[^\s<>"`)\]]+/gi) || [];
  return matches.map((raw) => raw.replace(/[.,;:!?]+$/, ""));
}

export function validateEvidenceManifest(
  manifest,
  {
    headSha,
    repository,
    headRepository,
    branch,
    prNumber,
    allowPendingUrl = false,
  } = {},
) {
  const errors = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["Evidence manifest must be a JSON object."];
  }

  if (manifest.schema_version !== 1) {
    errors.push("schema_version must be 1.");
  }

  const mode = manifest.mode;
  if (mode !== "video" && mode !== "non-demonstrable") {
    errors.push('mode must be "video" or "non-demonstrable".');
  }

  if (!isNonEmptyString(manifest.repository)) {
    errors.push("repository must be a non-empty owner/repo string.");
  } else {
    const allowedRepos = [repository, headRepository]
      .filter(isNonEmptyString)
      .map((r) => r.trim().toLowerCase());
    if (
      allowedRepos.length > 0 &&
      !allowedRepos.includes(manifest.repository.trim().toLowerCase())
    ) {
      errors.push(
        `repository mismatch: manifest has "${manifest.repository}", expected "${repository}".`,
      );
    }
  }

  if (!isNonEmptyString(manifest.branch)) {
    errors.push("branch must be a non-empty branch name.");
  } else if (
    isNonEmptyString(branch) &&
    manifest.branch.trim() !== branch.trim()
  ) {
    errors.push(
      `branch mismatch: manifest has "${manifest.branch}", expected "${branch}".`,
    );
  }

  if (
    !isNonEmptyString(manifest.commit_sha) ||
    !SHA40_RE.test(manifest.commit_sha.trim())
  ) {
    errors.push(
      "commit_sha must be a 40-character hexadecimal Git commit SHA.",
    );
  } else if (
    isNonEmptyString(headSha) &&
    manifest.commit_sha.trim().toLowerCase() !== headSha.trim().toLowerCase()
  ) {
    errors.push(
      `Stale evidence: manifest commit_sha (${manifest.commit_sha}) does not match PR head commit (${headSha}). Regenerate evidence against the latest commit.`,
    );
  }

  if (
    prNumber !== undefined &&
    prNumber !== null &&
    String(prNumber).trim() !== ""
  ) {
    const expectedPr = Number(prNumber);
    if (
      manifest.pr_number !== undefined &&
      manifest.pr_number !== null &&
      Number(manifest.pr_number) !== expectedPr
    ) {
      errors.push(
        `pr_number mismatch: manifest has ${manifest.pr_number}, expected ${expectedPr}.`,
      );
    }
  }

  if (!isValidIsoTimestamp(manifest.captured_at)) {
    errors.push("captured_at must be a valid ISO-8601 timestamp.");
  }

  if (!VALID_TARGETS.has(manifest.target)) {
    errors.push(`target must be one of: ${[...VALID_TARGETS].join(", ")}.`);
  } else if (mode === "video" && manifest.target === "non-demonstrable") {
    errors.push('target cannot be "non-demonstrable" when mode is "video".');
  } else if (
    mode === "non-demonstrable" &&
    manifest.target !== "non-demonstrable"
  ) {
    errors.push(
      'target must be "non-demonstrable" when mode is "non-demonstrable".',
    );
  }

  if (
    !Array.isArray(manifest.routes) ||
    manifest.routes.length === 0 ||
    !manifest.routes.every(isNonEmptyString)
  ) {
    errors.push(
      "routes must be a non-empty array of application routes or endpoints.",
    );
  }

  if (
    !manifest.environment ||
    typeof manifest.environment !== "object" ||
    manifest.environment.isolated !== true ||
    !isNonEmptyString(manifest.environment.description)
  ) {
    errors.push(
      "environment must specify isolated: true and a non-empty description of the isolated test environment.",
    );
  }

  const validDuration =
    mode === "video" &&
    typeof manifest.video?.duration_seconds === "number" &&
    Number.isFinite(manifest.video.duration_seconds) &&
    manifest.video.duration_seconds > 0
      ? manifest.video.duration_seconds
      : null;

  if (
    !Array.isArray(manifest.acceptance_criteria) ||
    manifest.acceptance_criteria.length === 0
  ) {
    errors.push("acceptance_criteria must be a non-empty array.");
  } else {
    manifest.acceptance_criteria.forEach((criterion, index) => {
      if (!criterion || typeof criterion !== "object") {
        errors.push(`acceptance_criteria[${index}] must be an object.`);
        return;
      }
      if (
        !isNonEmptyString(criterion.id) ||
        !isNonEmptyString(criterion.description)
      ) {
        errors.push(
          `acceptance_criteria[${index}] must include id and description.`,
        );
      }
      if (criterion.status !== "verified") {
        errors.push(
          `acceptance_criteria[${index}] (${criterion.id ?? index}) is not verified (status: "${criterion.status ?? ""}").`,
        );
      }
      if (mode === "video") {
        if (
          typeof criterion.demonstrated_at_seconds !== "number" ||
          !Number.isFinite(criterion.demonstrated_at_seconds) ||
          criterion.demonstrated_at_seconds < 0
        ) {
          errors.push(
            `acceptance_criteria[${index}] (${criterion.id ?? index}) must include a non-negative numeric demonstrated_at_seconds timestamp.`,
          );
        } else if (
          validDuration !== null &&
          criterion.demonstrated_at_seconds > validDuration
        ) {
          errors.push(
            `acceptance_criteria[${index}] (${criterion.id ?? index}) demonstrated_at_seconds (${criterion.demonstrated_at_seconds}) exceeds video.duration_seconds (${validDuration}).`,
          );
        }
      }
    });
  }

  if (
    !Array.isArray(manifest.test_results) ||
    manifest.test_results.length === 0
  ) {
    errors.push(
      "test_results must be a non-empty array of executed verification commands.",
    );
  } else {
    manifest.test_results.forEach((result, index) => {
      if (!result || typeof result !== "object") {
        errors.push(`test_results[${index}] must be an object.`);
        return;
      }
      if (
        !isNonEmptyString(result.command) ||
        !isNonEmptyString(result.summary)
      ) {
        errors.push(`test_results[${index}] must include command and summary.`);
      }
      if (result.status !== "passed") {
        errors.push(
          `test_results[${index}] (${result.command ?? index}) did not pass (status: "${result.status ?? ""}").`,
        );
      }
    });
  }

  const review = manifest.review_report;
  if (!review || typeof review !== "object") {
    errors.push(
      "review_report is required and must record independent engineering review results.",
    );
  } else {
    const documentedDocsSelfReview =
      mode === "non-demonstrable" &&
      review.independent === false &&
      isNonEmptyString(review.exception_reason) &&
      review.exception_reason.trim().length >= 15;
    if (review.independent !== true && !documentedDocsSelfReview) {
      errors.push(
        "review_report.independent must be true (the implementing agent must not be the sole reviewer; only non-demonstrable docs-only exemptions may document exception_reason).",
      );
    }
    if (
      !Array.isArray(review.reviewers) ||
      review.reviewers.length === 0 ||
      !review.reviewers.every(isNonEmptyString)
    ) {
      errors.push(
        "review_report.reviewers must list the independent reviewers executed.",
      );
    }
    if (review.verdict !== "ship") {
      errors.push(
        `review_report.verdict must be "ship" before marking ready (got "${review.verdict ?? ""}").`,
      );
    }
    if (
      typeof review.blocking_findings !== "number" ||
      !Number.isInteger(review.blocking_findings) ||
      review.blocking_findings !== 0
    ) {
      errors.push("review_report.blocking_findings must be 0.");
    }
  }

  if (mode === "video") {
    const video = manifest.video;
    if (!video || typeof video !== "object") {
      errors.push('video metadata is required when mode is "video".');
    } else {
      const hasUrl = isValidHttpsUrl(video.url);
      if (!hasUrl && !(allowPendingUrl && video.url === "pending-upload")) {
        errors.push(
          "video.url must be an accessible HTTPS URL pointing to the narrated recording.",
        );
      }
      if (video.codec_video !== "h264") {
        errors.push(
          `video.codec_video must be "h264" (got "${video.codec_video ?? ""}").`,
        );
      }
      if (video.codec_audio !== "aac") {
        errors.push(
          `video.codec_audio must be "aac" (got "${video.codec_audio ?? ""}").`,
        );
      }
      if (
        typeof video.width !== "number" ||
        typeof video.height !== "number" ||
        !Number.isInteger(video.width) ||
        !Number.isInteger(video.height) ||
        video.width < 1280 ||
        video.height < 720
      ) {
        errors.push(
          "video resolution must be integer dimensions of at least 1280x720 (default 1920x1080).",
        );
      }
      if (
        typeof video.fps !== "number" ||
        !Number.isFinite(video.fps) ||
        video.fps < 24
      ) {
        errors.push("video.fps must be at least 24 (default 30).");
      }
      if (
        typeof video.duration_seconds !== "number" ||
        !Number.isFinite(video.duration_seconds) ||
        video.duration_seconds <= 0
      ) {
        errors.push("video.duration_seconds must be a positive number.");
      }
      if (video.has_audio !== true) {
        errors.push(
          "video.has_audio must be true (audible synchronized narration is required).",
        );
      }
      if (video.has_captions !== true) {
        errors.push(
          "video.has_captions must be true (legible synchronized captions are required).",
        );
      }
      if (!isNonEmptyString(video.tts_provider)) {
        errors.push(
          "video.tts_provider must identify the TTS provider used (e.g. kokoro-onnx).",
        );
      }
      if (!isNonEmptyString(video.sha256) || !SHA256_RE.test(video.sha256)) {
        errors.push(
          "video.sha256 must be a lowercase 64-character SHA-256 checksum.",
        );
      }
    }

    const artifacts = manifest.artifacts;
    if (!artifacts || typeof artifacts !== "object") {
      errors.push(
        "artifacts must record preserved raw footage, transcript, and captions.",
      );
    } else {
      for (const field of [
        "raw_footage",
        "transcript",
        "captions_srt",
        "captions_vtt",
      ]) {
        if (!isNonEmptyString(artifacts[field])) {
          errors.push(
            `artifacts.${field} must record the preserved artifact reference.`,
          );
        }
      }
      if (
        manifest.target === "web" &&
        !isNonEmptyString(artifacts.playwright_trace)
      ) {
        errors.push(
          "artifacts.playwright_trace must record the preserved Playwright trace for web captures.",
        );
      }
      if (
        manifest.target === "desktop" &&
        !isNonEmptyString(artifacts.playwright_trace) &&
        !isNonEmptyString(artifacts.capture_log)
      ) {
        errors.push(
          "desktop captures must record either artifacts.playwright_trace or artifacts.capture_log.",
        );
      }
    }
  } else if (mode === "non-demonstrable") {
    const exemption = manifest.exemption;
    if (!exemption || typeof exemption !== "object") {
      errors.push(
        'exemption details are required when mode is "non-demonstrable".',
      );
    } else {
      if (
        !isNonEmptyString(exemption.reason) ||
        exemption.reason.trim().length < 20
      ) {
        errors.push(
          "exemption.reason must explain in at least 20 characters why video evidence is not applicable.",
        );
      }
      if (
        !Array.isArray(exemption.equivalent_artifacts) ||
        exemption.equivalent_artifacts.length === 0 ||
        !exemption.equivalent_artifacts.every(isNonEmptyString)
      ) {
        errors.push(
          "exemption.equivalent_artifacts must list non-empty equivalent verification artifacts.",
        );
      }
    }
  }

  for (const finding of detectSecrets(manifest)) {
    errors.push(`Secret hygiene violation: ${finding}.`);
  }

  return errors;
}

export function validatePrVideoEvidence({
  prBody,
  manifest: explicitManifest,
  headSha,
  repository,
  headRepository,
  branch,
  prNumber,
  changedFiles = [],
  allowPendingUrl = false,
}) {
  const errors = [];

  const binaryViolations = detectBinaryArtifacts(changedFiles);
  if (binaryViolations.length > 0) {
    errors.push(
      `Binary recording artifacts must not be committed to the repository: ${binaryViolations.join(", ")}.`,
    );
  }

  let manifest = explicitManifest ?? null;
  if (!manifest) {
    const extracted = extractEvidenceBlock(prBody);
    if (extracted.error) {
      errors.push(extracted.error);
      return {
        ok: false,
        errors,
        manifest: null,
        missingBlock: Boolean(extracted.missingBlock),
      };
    }
    manifest = extracted.manifest;
  }

  errors.push(
    ...validateEvidenceManifest(manifest, {
      headSha,
      repository,
      headRepository,
      branch,
      prNumber,
      allowPendingUrl,
    }),
  );

  if (typeof prBody === "string") {
    const demoSection = extractDemoSection(prBody);
    if (manifest.mode === "video") {
      const pendingAllowed =
        allowPendingUrl && manifest.video?.url === "pending-upload";
      if (!pendingAllowed) {
        const visibleUrls =
          extractHttpsUrls(demoSection).filter(isValidHttpsUrl);
        if (visibleUrls.length === 0) {
          errors.push(
            "PR description ## Demo section must include a visible, accessible HTTPS link to the narrated recording.",
          );
        } else if (
          isValidHttpsUrl(manifest.video?.url) &&
          !visibleUrls.includes(manifest.video.url.trim())
        ) {
          errors.push(
            "PR description ## Demo section must include the exact video.url declared in the pr-video-evidence manifest.",
          );
        }
      }
    } else if (manifest.mode === "non-demonstrable") {
      if (
        !/^n\/a\b[ \t]*(?:[-,:—–][ \t]*)?[^\s,:—–-][^\r\n]*(?:\r?\n[\s\S]*)?$/i.test(
          demoSection,
        )
      ) {
        errors.push(
          'PR description ## Demo section must begin with "N/A — <reason>" for non-demonstrable changes.',
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, manifest };
}

function sanitizeInline(text) {
  return String(text ?? "")
    .replaceAll(/[\r\n]+/g, " ")
    .replaceAll("`", "'")
    .trim();
}

function formatSummaryMarkdown(result, context, note = null) {
  const lines = ["## PR Video Evidence Verification", ""];
  if (note) {
    lines.push(`- **Status:** ${note}`);
  } else if (result.ok) {
    const m = result.manifest;
    lines.push("- **Status:** Passed");
    lines.push(`- **Mode:** \`${sanitizeInline(m.mode)}\``);
    lines.push(`- **Commit SHA:** \`${sanitizeInline(m.commit_sha)}\``);
    lines.push(`- **Target:** \`${sanitizeInline(m.target)}\``);
    lines.push(
      `- **Review verdict:** \`${sanitizeInline(m.review_report.verdict)}\` (${m.review_report.reviewers.map(sanitizeInline).join(", ")})`,
    );
    if (m.mode === "video") {
      lines.push(
        `- **Video:** ${m.video.width}x${m.video.height} @ ${m.video.fps}fps (${sanitizeInline(m.video.codec_video)}/${sanitizeInline(m.video.codec_audio)}, ${m.video.duration_seconds}s, TTS: \`${sanitizeInline(m.video.tts_provider)}\`)`,
      );
      lines.push(`- **Recording link:** ${sanitizeInline(m.video.url)}`);
    } else {
      lines.push(
        `- **Exemption reason:** ${sanitizeInline(m.exemption.reason)}`,
      );
    }
  } else {
    lines.push("- **Status:** Failed");
    if (context.headSha) {
      lines.push(
        `- **Expected Commit SHA:** \`${sanitizeInline(context.headSha)}\``,
      );
    }
    lines.push("", "### Blocking Issues", "");
    for (const error of result.errors) {
      lines.push(`- ${sanitizeInline(error)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function isAutomatedReleaseOrBotPr(pr, baseRepository, changedFiles = []) {
  if (!pr) return false;
  if (pr.user?.type === "Bot") return true;
  const headRepo = pr.head?.repo?.full_name?.toLowerCase();
  const sameRepo =
    isNonEmptyString(baseRepository) &&
    headRepo === baseRepository.trim().toLowerCase();
  const packagingOnly =
    changedFiles.length > 0 &&
    changedFiles.every((file) =>
      AUTOMATED_RELEASE_ALLOWED_PATH_RE.test(
        String(file).trim().replaceAll("\\", "/"),
      ),
    );
  if (
    sameRepo &&
    AUTOMATED_RELEASE_BRANCH_RE.test(pr.head?.ref || "") &&
    packagingOnly
  ) {
    return true;
  }
  return false;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "allow-pending-url": { type: "boolean", default: false },
      "pr-body-file": { type: "string" },
      "github-event-path": { type: "string" },
      manifest: { type: "string" },
      "changed-files-file": { type: "string" },
      "head-sha": { type: "string" },
      repository: { type: "string" },
      "head-repository": { type: "string" },
      branch: { type: "string" },
      "pr-number": { type: "string" },
      "summary-file": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  let eventPr = null;
  if (values["github-event-path"]) {
    const payload = JSON.parse(
      await readFile(values["github-event-path"], "utf8"),
    );
    eventPr = payload.pull_request ?? null;
  }

  let prBody;
  if (values["pr-body-file"]) {
    prBody = await readFile(values["pr-body-file"], "utf8");
  } else if (eventPr) {
    prBody = eventPr.body ?? "";
  } else if (process.env.PR_BODY !== undefined) {
    prBody = process.env.PR_BODY;
  }

  let manifest;
  if (values.manifest) {
    manifest = JSON.parse(await readFile(values.manifest, "utf8"));
  }

  let changedFiles = [];
  if (values["changed-files-file"]) {
    const raw = await readFile(values["changed-files-file"], "utf8");
    changedFiles = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const repository = values.repository ?? process.env.PR_REPOSITORY;
  const headRepository =
    values["head-repository"] ??
    eventPr?.head?.repo?.full_name ??
    process.env.PR_HEAD_REPOSITORY;
  const context = {
    prBody,
    manifest,
    headSha:
      values["head-sha"] ?? eventPr?.head?.sha ?? process.env.PR_HEAD_SHA,
    repository,
    headRepository,
    branch: values.branch ?? eventPr?.head?.ref ?? process.env.PR_BRANCH,
    prNumber: values["pr-number"] ?? eventPr?.number ?? process.env.PR_NUMBER,
    changedFiles,
    allowPendingUrl: values["allow-pending-url"],
  };

  const summaryFile = values["summary-file"] ?? process.env.GITHUB_STEP_SUMMARY;

  if (isAutomatedReleaseOrBotPr(eventPr, repository, changedFiles)) {
    const binaryViolations = detectBinaryArtifacts(changedFiles);
    if (binaryViolations.length > 0) {
      const result = {
        ok: false,
        errors: [
          `Binary recording artifacts must not be committed to the repository: ${binaryViolations.join(", ")}.`,
        ],
        manifest: null,
      };
      if (summaryFile) {
        await appendFile(
          summaryFile,
          formatSummaryMarkdown(result, context),
          "utf8",
        );
      }
      console.error(result.errors[0]);
      process.exitCode = 1;
      return;
    }
    const note = "Skipped (automated bot or release packaging pull request)";
    if (summaryFile) {
      await appendFile(
        summaryFile,
        formatSummaryMarkdown(
          { ok: true, errors: [], manifest: null },
          context,
          note,
        ),
        "utf8",
      );
    }
    console.log(note);
    return;
  }

  const result = validatePrVideoEvidence(context);

  const isDraftPending =
    eventPr?.draft === true &&
    !result.ok &&
    result.missingBlock === true &&
    detectBinaryArtifacts(changedFiles).length === 0;

  if (isDraftPending) {
    const note =
      "Pending (Draft PR — attach fresh narrated video evidence before marking ready for review)";
    if (summaryFile) {
      await appendFile(
        summaryFile,
        formatSummaryMarkdown(result, context, note),
        "utf8",
      );
    }
    console.log(note);
    return;
  }

  if (summaryFile) {
    await appendFile(
      summaryFile,
      formatSummaryMarkdown(result, context),
      "utf8",
    );
  }

  if (!result.ok) {
    console.error("PR video evidence verification failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `PR video evidence verified (${result.manifest.mode}, commit ${result.manifest.commit_sha}).`,
  );
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
