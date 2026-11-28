---
name: pr-video-evidence
description: >
  Use for every implementation task, feature, bug fix, refactor,
  and pull request, including subsequent review corrections.
  Produce narrated video evidence of the actual implementation,
  with visual annotations, passing assertions, synchronized
  captions, and playable attachments before declaring work
  complete or marking a pull request ready for review.
---

# Narrated PR Video Evidence

## 1. Objective

Enable asynchronous engineering review without requiring the reviewer to check out branches, start applications, reproduce workflows, or manually verify every implementation.

Every applicable implementation must be accompanied by a concise, narrated, visually annotated recording that demonstrates the actual working functionality.

The reviewer should be able to inspect the code, watch the recording, annotate specific video frames in the review thread (such as Capy or a pull request review), submit feedback, and review a corrected implementation.

This is a mandatory engineering verification workflow, not a marketing video production workflow.

## 2. When to execute

Execute this skill:

- Before marking any pull request ready for review.
- Before reporting an implementation as complete.
- After implementing a feature or fixing a bug.
- After addressing pull request review comments.
- After receiving visual annotations or feedback in Capy or pull request review threads.
- After changes that invalidate previous verification evidence.

Execute automatically across every project, repository, and model, even when the user has not explicitly requested a recording, demonstration, or verification. Do not wait for the reviewer to request evidence.

Review-only subagents must not recursively initiate this workflow.

## 3. Understand the implementation

Before recording:

1. Read the original task and acceptance criteria.
2. Inspect the implementation and relevant code changes.
3. Identify every affected user-facing workflow.
4. Identify relevant backend behavior and side effects.
5. Identify important edge cases and failure states.
6. Determine what observable evidence would demonstrate that each acceptance criterion has been satisfied.

Create a verification plan mapping acceptance criteria to tests, browser or terminal actions, and observable results.

Do not merely demonstrate the happy path when the change also affects permissions, validation, financial calculations, error handling, or data persistence.

## 4. Prepare the verification environment

Use the actual implementation from the current branch.

- Start the required application and dependent services (`pnpm dev:web`, `pnpm dev:desktop`, `pnpm dev:local`, or an isolated service/CLI harness for Shots Founder Hub).
- Use the repository's established setup and seed scripts.
- Use isolated, deterministic test fixtures.
- Authenticate using approved test accounts.
- Verify the application is healthy before recording.
- Use fictional or sanitized customer and financial data.
- Prevent real payments, customer messages, emails, notifications, or other external side effects.

Never bypass authentication, permissions, or application validation to make a demonstration succeed. Never substitute a mock interface for a working application.

If environment setup fails, investigate and resolve the failure where possible. Otherwise, report the exact blocker and keep the pull request in draft.

## 5. Execute automated verification

Run all applicable repository-mandated checks (treat `.github/workflows/` and `AGENTS.md` as the source of truth), including:

- Type checking.
- Linting and formatting (`dprint`, `oxlint`, `eslint`).
- Unit tests.
- Integration tests.
- Contract tests.
- End-to-end tests.
- Security and authorization checks (including `zizmor` when workflows change).
- Financial correctness checks where applicable.

Reuse existing test infrastructure. For each demonstrated workflow, assert the expected result using the application UI, API response, database state, or another appropriate verification mechanism.

A successful video recording does not replace automated tests. Never claim a behavior works unless it has been observed and verified.

## Mandatory independent engineering review

Narrated video evidence must be generated only after the implementation has passed independent engineering review. A successful demonstration is not sufficient evidence of architectural correctness, security, financial accuracy, maintainability, or production readiness.

### 1. Discover repository-specific reviewers

Before implementation, inspect the repository's:

- `AGENTS.md`
- `CLAUDE.md`
- Nested product-specific instruction files
- `.codex/agents/`
- `.claude/agents/`
- `.claude/skills/`
- `.claude/prompts/`
- `.agents/skills/`
- Other repository-defined review procedures (such as `REVIEW.md`)

Load all applicable repository instructions. Identify the available review agents, their responsibilities, their invocation conditions, and the required quality gates. Reuse existing reviewer definitions rather than replacing them with generic review prompts. Current repository and product-specific guardrails take precedence over outdated assumptions in reviewer definitions.

### 2. Review orchestration

After implementation and initial verification, assemble an independent review team. The implementing agent acts as the review coordinator and must never be the sole reviewer of its own implementation.

Dispatch independent reviewers in parallel where their responsibilities do not require sequential execution. Each reviewer must receive:

- Original task and acceptance criteria.
- Base branch and current commit SHA.
- Actual implementation diff and paths of untracked files.
- Relevant architecture and repository instructions.
- Affected components, callers, and execution paths.
- Existing and newly added tests.
- Initial verification results.
- Known risks and unresolved questions.

Reviewers must inspect the actual source code and tests — never rely solely on the implementing agent's summary. Reviewers operate in read-only mode so the implementing agent coordinates all remediation without conflicting edits. Do not recursively dispatch additional review teams from review-only subagents.

### 3. Mandatory core review team

#### In Shots Founder Hub (`PlaybookMediaLLC/shots-founder-hub`)

Follow `AGENTS.md#mandatory-implementation-review` and `.codex/agents/reviewer.toml`. Dispatch separate read-only `reviewer` instances across all five core perspectives:

- **structure**: correctness, security, contracts, and module boundaries.
- **perf**: performance, resource use, and expensive execution paths.
- **chaos**: invalid inputs, failure modes, cleanup, and resilience.
- **qa**: test coverage, assertion quality, and missing cases (judged by `REVIEW.md` and `.agents/skills/testing/SKILL.md`).
- **lean**: unnecessary abstractions, dependencies, and speculative code.

Add up to two relevant domain specialists according to the affected functionality (frontend/React, Rust/Tauri/audio, API/auth/CloudSync, SQLite/Postgres migrations, entitlements/billing, CI/workflow security).

#### When working in Oppulence Canvas

Load and execute the Oppulence Canvas core reviewers for every substantive code change:

1. **Senior engineering reviewer** (`.claude/agents/senior-code-critic.md`): implementation correctness, architectural integrity, maintainability, security, performance, error handling, concurrency/race conditions, test quality and coverage, unnecessary complexity, with a concrete merge recommendation.
2. **Structural and blast-radius reviewer** (`.claude/skills/review-changes/SKILL.md`): use `code-review-graph` MCP starting with `get_minimal_context_tool` to inspect risk-scored changed functions, callers/callees, execution flows, shared dependencies, impact radius, and untested high-risk behavior. Verify with targeted source inspection; if the graph integration is unavailable, disclose the limitation and run targeted source-based impact analysis (never fabricate graph results).
3. **Simplicity and production-quality reviewer** (`.claude/skills/ponytail-review/SKILL.md`): evaluate in order — correctness, safety, expected production load, adequate testing, performance, simplicity. Identify unnecessary abstractions, duplication, speculative code, dead code, and maintainability defects with concrete failure scenarios or unnecessary costs.

### 4. Specialist reviewer selection

Dispatch additional specialists according to the affected functionality and risk profile. Do not omit an applicable specialist merely because the core review team reported no findings.

- **Frontend and React changes**: inspect runtime failures, React lifecycle and `no-use-effect` rules, hydration, async state, accessibility, rendering, data fetching, memory leaks, and visual/responsive quality. In Oppulence Canvas, use `.claude/agents/nextjs-deep-bug-hunter.md` and (for material visual changes) `.claude/agents/premium-ui-architect.md`.
- **API, mutation, and business logic changes**: verify input/output contracts, schema/Zod validation, authentication and authorization, tenant isolation, error semantics, side effects, business logic ownership, transaction boundaries, and UI/API/CLI/MCP parity. In Oppulence Canvas, use `corinthian/.claude/agents/api-first-enforcer.md` and `corinthian/.claude/agents/api-standards-enforcer.md`.
- **Security and financial changes**: dispatch a dedicated security and financial correctness reviewer for changes affecting money movement, payment instructions, invoices/collections, banking/transactions, forecasting/financial calculations, permissions/authorization, tenant-owned data, external integrations, webhooks, background jobs, migrations, sensitive data, or automated financial actions. Verify monetary units, currency preservation, rounding semantics, tenant isolation, authorization, idempotency, duplicate/retry safety, concurrency, out-of-order events, partial failure, database constraints, transactional correctness, reconciliation, auditability, and recovery. Do not treat passing mock-based tests as proof of database, transaction, or tenant-isolation correctness. In Oppulence Canvas, use `.claude/prompts/security-review.md` and `corinthian/.claude/prompts/security-review.md`.
- **Entitlements and feature gating**: verify server-side and client-side enforcement, onboarding requirements, redirects, and fail-closed behavior. In Oppulence Canvas, use `.claude/agents/requirements-gating-architect.md`.
- **Code quality remediation**: restrict refactoring strictly to concrete quality, duplication, type-safety, or complexity defects identified in review. In Oppulence Canvas, use `.claude/agents/deslop-refactor.md`.

### 5. Cross-agent compatibility

These review procedures apply regardless of whether the implementing agent is Claude Code, Codex, Capy, Antigravity, or another supported coding agent. When native custom subagent invocation is available, invoke the repository-defined reviewers directly; otherwise, read the reviewer definition and dispatch an independent subagent with its full instructions. Never claim an independent review occurred if subagents were unavailable — report the blocker and keep the PR in draft.

### 6. Review findings and severity

Require every reviewer to return structured findings containing:

- Reviewer identity and finding identifier.
- Severity (`P0`, `P1`, `P2`, or `P3`).
- File path and line numbers.
- Affected behavior and concrete failure scenario.
- Supporting evidence.
- Smallest recommended correction and required verification.

Severity policy:

- **P0 — Critical**: potential financial corruption, cross-tenant data exposure, unauthorized financial/privileged actions, credential exposure, or other critical failures. Blocks readiness.
- **P1 — High**: material correctness, authorization, financial reporting, reconciliation, or reliability defects. Blocks readiness.
- **P2 — Medium**: recoverable inconsistencies, limited operational failures, maintainability risks, and meaningful edge cases. Resolve before merge unless explicitly accepted by the authorized reviewer.
- **P3 — Low**: non-critical readability, naming, and cleanup observations. Must not distract from higher-risk defects.

### 7. Consolidate and adjudicate findings

Collect all reviewer results into one consolidated review report:

- Deduplicate overlapping findings and verify every finding against actual source code.
- Resolve disagreements using evidence; reject unsupported or speculative findings with documented rationale.
- Identify shared root causes and prioritize corrections by severity.

### 8. Mandatory remediation and re-review

Resolve all blocking findings (`P0`, `P1`, and unresolved `P2` blockers) without weakening tests, validation, authorization, invariants, or quality gates:

1. Rerun the relevant automated tests.
2. Return the corrected implementation to the applicable independent reviewers.
3. Require independent verification that original findings are resolved and no new defects were introduced.
4. Repeat until all blocking findings are closed.

The implementing agent may not close blocking findings solely through self-certification. If review cannot converge, keep the pull request in draft and report the unresolved findings.

### 9. Final repository quality gates

- **In Shots Founder Hub**: execute all affected workflow checks from `AGENTS.md` and `.github/workflows/` (`dprint check`, `oxlint`, `eslint`, license boundary checks, `node --test` script tests, affected TS/Rust typechecks and tests, `zizmor` for workflow changes, and `pnpm devx:video-evidence:verify`).
- **In Oppulence Canvas**: execute `bun run gauntlet --changed`, `bun run devx:ship-check --profile=pr`, `bun run devx:pr-evidence`, and `bun run devx:ship-check:financial` for P0 financial surfaces. Do not alter the Gauntlet baseline or quality budgets or add unnecessary hosted CI workflows.

Any failed mandatory quality gate blocks readiness for review.

### 10. Review evidence manifest

Preserve a structured review record alongside the video evidence manifest (`evidence.json` / `review-report.json`) containing: repository, base branch, reviewed commit SHA, reviewer identities, reviewer source definitions, specialist selection rationale, review scope, findings by severity, corrections applied, findings independently verified as resolved, accepted exceptions and authorization, outstanding findings, automated verification results, and final review recommendation (`ship` or `no-ship`). Both the review report and video must describe the exact same commit.

### 11. Narrated video generation

Generate the final narrated recording only after independent engineering review is complete, all blocking findings are resolved, mandatory quality gates pass, and the final implementation commit is identified. Include demonstration beats for important defects fixed during review where helpful to the human reviewer. Deliver both the playable narrated video and consolidated engineering review report in the review thread.

### 12. Subsequent review iterations

When human feedback produces implementation changes: reassess blast radius, dispatch core and applicable specialist reviewers, resolve new and outstanding findings, rerun verification, regenerate the narrated video, update the review report, and bind all evidence to the new commit SHA. Never reuse stale review approvals or video evidence.

### 13. Final readiness gate

An implementation must not be declared complete or marked ready for review until:

- Core review team executed.
- Applicable specialist reviewers executed.
- Review findings consolidated.
- P0 and P1 findings independently verified as resolved.
- P2 findings resolved or explicitly accepted.
- Repository quality gates passed.
- Financial and security invariants verified where applicable.
- Review report attached.
- Narrated video attached where applicable.
- Evidence associated with the current commit.
- Remaining limitations disclosed.

Never merge without explicit authorization.

## 6. Build the demonstration storyboard

Generate a structured storyboard (a JSON plan for `pnpm devx:video-evidence`) before recording. Each cue/beat must specify:

- Acceptance criterion ID and description.
- Application route or starting state.
- Browser or terminal action.
- Target element/locator or command.
- Expected result and assertion confirming it.
- Spoken narration text.
- Visual annotation (highlight label, cursor target, click indicator, optional restrained zoom).

Organize the recording around what the reviewer needs to understand rather than the order code was written. Show the prior failure or problem when useful, followed by the corrected behavior. Prioritize evidence over presentation.

## 7. Capture the actual application

For web applications, prefer Playwright and Chromium. Reuse existing browser fixtures, recording scripts, authentication utilities, and test helpers (such as `scripts/pr-video-evidence/` and `e2e/blackbox/` in Shots Founder Hub).

Record actual interactions, including relevant navigation, mouse movement and clicking, form inputs, menu and dialog interactions, data changes, validation messages, loading/success states, error/recovery states, and persisted state after navigation or refresh.

Do not record long installation sequences, compilation delays, irrelevant navigation, or unnecessary waiting. Do not edit out footage that exposes a genuine application failure in order to present a misleading successful result.

## 8. Visual annotations

Every recording must make it immediately apparent which part of the interface is being discussed:

- Element bounding boxes and subtle callout labels.
- Visible smooth cursor movement and click indicators.
- Arrows, numbered callouts, or spotlights when clarifying relationships.
- Restrained camera zooms for small or dense controls.

Derive element coordinates from live Playwright locators wherever possible. Keep annotations synchronized with the corresponding action and narration, and ensure they never obscure important text, controls, financial values, or results. Avoid decorative animations, unnecessary motion, and excessive zooming. Preserve the unmodified raw capture alongside the annotated render.

## 9. Spoken narration

Every applicable demonstration must include audible, intelligible spoken narration.

- **Default local TTS**: Kokoro (`kokoro-onnx`, cached under `~/.cache/kokoro-onnx/`).
- **Local fallback**: `espeak-ng` when Kokoro weights are unavailable offline (disclosed in `tts_provider`).
- **Optional cloud fallback**: approved cloud TTS provider (such as OpenAI TTS via `--tts-provider openai` with `OPENAI_API_KEY`) only when explicitly configured and authorized; never transmit sensitive data.

Generate narration as individual segments per beat, measure exact audio duration, and synchronize the recording timeline accordingly.

Narration must explain:

- What was broken or missing.
- What changed and why it was necessary.
- How the new behavior works and what the user is doing.
- What the application does in response.
- Which acceptance criterion is being demonstrated.
- Relevant edge cases, limitations, or outstanding concerns.

Use direct, natural engineering language. Do not read every interface label aloud. Do not add background music, promotional language, generic intros/outros, or unverified claims.

## 10. Audio and video synchronization

Narration, recorded actions, visual annotations, cursor movement, and captions share one timeline:

- Measure narration segment durations before executing/pacing demonstration beats.
- Keep narration tightly aligned with the currently visible screen and highlighted element.
- Keep captions exact to the spoken narration.
- Verify clear, unclipped audio with no truncated narration or unintended dead air.
- Apply identical timeline transforms across video, audio, and captions if trimming.

## 11. Recording specifications

Default output profile (engineering verification profile — separate from any silent marketing profiles):

- Container: MP4 (`+faststart`).
- Video codec: H.264 (`libx264`, `yuv420p`).
- Audio codec: AAC (`aac`, 48 kHz).
- Resolution: 1920 × 1080 (16:9).
- Frame rate: 30 fps.
- Captions: legible burned-in subtitles plus preserved `.srt` and `.vtt` files.
- Narration: clear spoken voice.
- Background music: none.

Target 30–120 seconds for straightforward changes. Produce multiple focused recordings for larger implementations rather than one sprawling video. Do not enforce an arbitrary duration limit that prevents adequate verification.

## 12. Backend and infrastructure implementations

Video evidence is not limited to frontend changes. For backend, API, database, worker, CLI, infrastructure, or developer-tooling changes, record observable behavior via `pnpm devx:video-evidence` (terminal/API mode) showing:

- Terminal sessions and CLI workflows.
- API requests and responses.
- Database queries and assertions.
- Integration test execution, worker processing, or event propagation.
- Observability dashboards or before/after performance measurements.
- Error handling and recovery.

Narrate what is being verified, highlight key outputs, and redact all credentials and sensitive values.

For genuinely non-demonstrable changes (for example, purely mechanical doc edits or lockfile-only maintenance with zero behavioral change), generate an explicit exemption manifest via `pnpm devx:video-evidence exempt` documenting why video evidence is not applicable and listing equivalent verification artifacts. Never silently skip verification.

## 13. Evidence integrity

Associate every recording with:

- Repository name and branch name.
- Exact 40-character commit SHA.
- Pull request number (once assigned).
- Capture timestamp (ISO-8601 UTC).
- Application routes or endpoints and isolated test environment details.
- Demonstrated acceptance criteria with timestamps and assertion results.
- Executed test commands and actual results.
- Consolidated independent review report summary (`verdict`, reviewers, zero blocking findings).
- Known limitations.

Preserve raw footage, transcript, `.srt`/`.vtt` captions, Playwright `trace.zip` (for browser captures), review frames, and `evidence.json` under `.tmp/pr-video-evidence/<run-id>/` (gitignored).

Never expose credentials, auth tokens, real financial data, or customer PII. Never commit binary recording or trace files to the repository. Never reuse an earlier commit's recording after relevant code, configuration, or behavior changes.

## 14. Review the recording before delivery

Inspect the generated recording before presenting it:

- Verify file existence, decodability, codecs (`h264`/`aac`), dimensions (`1920x1080`), frame rate (`30 fps`), and non-silent audio via `ffprobe` and `ffmpeg volumedetect`.
- Visually inspect extracted review frames for every demonstration beat to verify legibility, cursor/highlight accuracy, zoom framing, caption placement, and absence of sensitive data or broken UI.
- Verify coverage of all acceptance criteria and alignment with the current commit SHA.
- Run `pnpm devx:video-evidence:verify` against the manifest and PR description block.

If inspection reveals any defect, fix the implementation or recording and regenerate. Never deliver silent, broken, stale, or fabricated recordings.

## 15. Deliver evidence

Deliver the actual playable MP4 attachment in the review thread (using Capy's attachment mechanism, or the host platform's playable video artifact/attachment mechanism) so the reviewer can play and annotate individual frames. Never deliver only a raw filesystem path or text summary.

Include the accessible video link (never use unauthorized public file hosts for private recordings) and structured evidence block in the pull request description. Retain supporting artifacts (raw capture, transcript, captions, trace, manifest, review report) outside git. If the attachment cannot be delivered, report the exact blocker and keep the PR in draft.

## 16. Pull request evidence summary

Include the structured PR evidence block generated by `pnpm devx:video-evidence` in every applicable pull request description:

```markdown
### Narrated verification

Recording: [Playable demonstration](https://...)
Commit: `<40-char-sha>`

### Demonstrated behavior

| Acceptance criterion | Timestamp | Verification |
| --- | --- | --- |
| Criterion | 00:00 | Passed |

### Automated checks

- `<command>` — passed

### Known limitations

- Document any unverified behavior, environment limitations, or outstanding concerns.
```

Also include the machine-validated `<!-- pr-video-evidence:start --> ... <!-- pr-video-evidence:end -->` JSON block emitted by `pnpm devx:video-evidence` so the `pr-video-evidence` GitHub Actions check can verify freshness, metadata completeness, test results, and review status.

## 17. Visual feedback loop

When the reviewer annotates video frames or submits pull request review comments:

1. Inspect every annotated frame and associated comment.
2. Retrieve the corresponding recording and commit context.
3. Locate the affected component or implementation.
4. Convert the feedback into concrete acceptance criteria.
5. Implement the requested corrections and add/update regression tests.
6. Repeat applicable independent engineering reviews and automated verification.
7. Generate a fresh narrated recording against the new commit SHA.
8. Attach the updated recording to the same thread and update the PR description.
9. Explicitly list which review comments have been addressed and which remain outstanding.

Preserve prior recordings as historical evidence; never reuse an outdated recording to represent subsequent commits. Repeat until explicitly approved.

## 18. Repository integration

### Shots Founder Hub (`PlaybookMediaLLC/shots-founder-hub`)

Use the repository-native pipeline:

- **Record narrated video evidence**: `pnpm devx:video-evidence --plan <plan.json> [--tts-provider auto|kokoro|espeak|openai] [--video-url <url>] [--pr-number <N>]`
- **Document non-demonstrable exemption**: `pnpm devx:video-evidence exempt --reason "<reason>" --artifact "<artifact>" --plan <metadata.json>` (validated against the same CI schema; docs-only exemptions may record `review_report.independent: false` only with an explicit `review_report.exception_reason`).
- **Update PR block after upload/PR creation**: `pnpm devx:video-evidence render-pr-block --manifest <evidence.json> --video-url <url> --pr-number <N>` (keeps `commit_sha` immutable and validates against live `HEAD` before writing).
- **Validate locally**: `pnpm devx:video-evidence:verify --manifest <evidence.json> --head-sha <sha>` (same validator executed by `.github/workflows/pr-video-evidence.yml`; enforces `1280x720 @ 24 fps` minimum with `1920x1080 @ 30 fps` default).
- **Desktop blackbox capture**: `e2e/blackbox/record.ts` provides X11 `ffmpeg` capture for native Tauri WebDriver tests when desktop native flows are exercised (`target: "desktop"` accepts either `artifacts.playwright_trace` or `artifacts.capture_log`).

Keep engineering verification outputs in `.tmp/pr-video-evidence/` (gitignored). Do not commit binary media files.

### Oppulence Canvas integration

When working in Oppulence Canvas, inspect and reuse the existing infrastructure:

- `tooling/local/src/scripts/docs/screencast.ts`
- `tooling/local/src/scripts/docs/record-eigenn-video.ts`
- `tooling/local/src/scripts/devx/pr-evidence.ts`
- `tooling/local/src/scripts/devx/pr-evidence-markdown.ts`
- `videos/src/manifest.ts`
- `videos/src/demo.tsx`
- `videos/render.ts`

Extend the existing pipeline (`devx:video-evidence` with Eigenn and Conduitt support) rather than introducing a second incompatible system, and keep engineering verification recordings completely separate from silent marketing video profiles.

## 19. Failure handling

If any mandatory verification, review, or recording step fails:

- Investigate and fix the root cause where possible, then rerun verification and regenerate evidence.
- If the failure cannot be resolved, report the exact blocker, commands attempted, relevant error output, what remains unverified, and the action required to proceed.
- Keep the pull request in draft. Never bypass quality gates or fabricate evidence.

## 20. Definition of done

An implementation is ready for review only when:

- [ ] Original acceptance criteria are addressed.
- [ ] Applicable automated tests and quality gates pass.
- [ ] Independent engineering review completed and all blocking findings independently verified as resolved.
- [ ] Actual running implementation behavior and relevant failure states have been verified.
- [ ] Narrated H.264/AAC 1920×1080 @ 30 fps recording has been generated.
- [ ] Visual annotations (cursor, clicks, bounding boxes, restrained zooms) are accurate and legible.
- [ ] Captions and spoken narration are synchronized and verified.
- [ ] Recording and frames passed quality inspection (`ffprobe`, `volumedetect`, visual frame review).
- [ ] Evidence manifest and PR metadata match the exact current commit SHA.
- [ ] Playable recording and consolidated review report are delivered in the review thread.
- [ ] Pull request description includes the accessible video link and validated evidence summary.
- [ ] Remaining limitations are explicitly documented and no sensitive information is exposed.

For genuinely non-demonstrable changes, document the justification and equivalent artifacts via `pnpm devx:video-evidence exempt`. Never merge a pull request without explicit authorization.
