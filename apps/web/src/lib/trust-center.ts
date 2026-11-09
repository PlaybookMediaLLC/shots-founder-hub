export const TRUST_CENTER_UPDATED_ON = "2026-11-09";

export const securityReviewAnswers = [
  {
    question: "How is meeting content encrypted?",
    summary:
      "The implemented sync path encrypts supported content before upload. Shared notes and Cloud API copies have separate, server-readable paths.",
    detail:
      "The desktop stores notes, transcripts, and meeting metadata in local SQLite, with audio and attachments as separate files. The implemented encrypted-sync path sends ciphertext and operational metadata to sync storage. Shared notes and Cloud API connectors can create separate server-readable copies. Deployed encryption settings, key handling, access controls, and enabled paths still require operational verification; this review draft is not a deployment attestation.",
  },
  {
    question: "Where does data live, and which jurisdiction applies?",
    summary:
      "Playbook reports US East and US West operations. Exact provider-region mappings and downstream locations remain unspecified; repository defaults are separate evidence.",
    detail:
      "Playbook owns and operates the product’s cloud-service accounts and reports US East and US West operations. This has not been independently account-verified. Exact provider mappings, replicas, backups, downstream processing, and any governing-law provisions remain unspecified. Repository Fly templates specify sjc, generated Vercel functions specify sfo1, and PostHog defaults to a US endpoint. These source values do not establish active production vendors or actual processing locations; their difference from the confirmed operating inventory needs reconciliation.",
  },
  {
    question: "How long do you keep data?",
    summary:
      "Playbook confirms indefinite hosted retention until user deletion or a request, same-day request processing, and monitored deletion jobs. Completed erasure has no formal deadline.",
    detail:
      "Playbook states that deletion jobs are enabled and monitored and requests are handled or initiated the same day. These are user-confirmed practices, not independently observed results or a same-day erasure guarantee. The local audio fallback is Forever, with explicit or legacy don’t-save, 1, 3, 7, or 30-day options. Uploaded audio callback cleanup is best-effort. Account deletion is asynchronous and its initial 24h 5m safety horizon can be extended; that wait is not a completion SLA. Workspace retention covers shares and snapshots only. Backup erasure, log expiry, provider-held records, and legal or billing exceptions remain unspecified.",
  },
  {
    question: "Do you train models on our meetings?",
    summary:
      "Playbook states that its AI providers do not use content for training. This is a user-confirmed operational statement, not independent verification of vendor accounts or agreements.",
    detail:
      "Playbook identifies OpenRouter as active and states that its AI providers do not use content for training. The supporting account settings and agreements have not been independently verified. Provider prompt and response retention and downstream model routing remain to be documented. Local models process supported requests on the device; hosted routes can send audio, text, and request context off-device. Optional AI, speech, diarization, and research integrations in source do not establish active production vendors or their policies.",
  },
  {
    question: "Who are your subprocessors?",
    summary:
      "Playbook identifies DigitalOcean, Azure, Resend, Stripe, OpenRouter, and OpenPanel as active. The separate repository inventory does not establish that its other vendors are active.",
    detail:
      "Playbook confirms DigitalOcean, Azure, Resend, Stripe, OpenRouter, and OpenPanel, with OpenPanel for session replay. These statements have not been independently account-verified. The repository separately contains Fly/Vercel, Supabase, SQLite Cloud, Nango, Loops, optional speech and research integrations, PostHog, Google Analytics, Microsoft Clarity, and Sentry paths. Their presence is not a claim of active use. Exact provider-region mappings, any additional analytics tools, replay retention, consent, masking, and provider agreements remain unspecified; configuration differences require separate reconciliation.",
  },
  {
    question: "Does a bot join our calls?",
    summary:
      "The desktop capture flow records supported microphone and system audio locally without adding a meeting participant.",
    detail:
      "The desktop capture implementation uses microphone and system audio rather than adding a bot to the call. Any separately configured enterprise capture worker is a different path and must be assessed separately. Before recording or sharing someone else’s words, provide required notice and obtain the required permission. This description of the desktop implementation does not verify which optional capture services are deployed.",
  },
];

export const architectureLayers = [
  {
    title: "User devices",
    body: "Canonical notes, transcripts, and meeting metadata live in local SQLite. Recordings and attachments are separate local files. Local audio has its own retention setting.",
  },
  {
    title: "Optional encrypted sync",
    body: "The implemented sync path encrypts supported content before upload. Sync storage also handles operational metadata; deployed settings and access still require verification.",
  },
  {
    title: "Optional AI and transcription",
    body: "Supported on-device models, bring-your-own keys, and hosted routes have different data paths. The actual enabled vendors, downstream routing, and provider policies remain to be confirmed.",
  },
  {
    title: "Optional sharing and Cloud API",
    body: "Sharing and remote-access features can create server-readable copies. Revocation, retention, and cleanup must be verified separately from encrypted sync; no deletion deadline is established here.",
  },
];

export const subprocessors = [
  {
    name: "Fly.io, Vercel, Supabase, Cloudflare",
    purpose: "Code-supported hosting, authentication, storage, and delivery",
    receives:
      "Depending on deployment: requests, account data, operational metadata, and records needed by enabled hosted features; active services and regions unverified",
  },
  {
    name: "SQLite Cloud",
    purpose: "Optional Cloud Sync storage",
    receives:
      "Encrypted sync records and operational metadata on the implemented path; active project and region unverified",
  },
  {
    name: "Nango",
    purpose: "Connected-account integration paths",
    receives:
      "OAuth credentials and authorized integration data when the corresponding path is enabled; deployed scopes and configuration unverified",
  },
  {
    name: "Stripe",
    purpose: "Billing integration",
    receives:
      "Customer, subscription, and payment information for enabled paid services; account settings and provider retention unverified",
  },
  {
    name: "PostHog, Google Analytics, Microsoft Clarity",
    purpose: "Product and website analytics integrations",
    receives:
      "Usage and page events; Clarity supports session replay. Actual enablement, consent, content masking, collection, and retention unverified",
  },
  {
    name: "Sentry and the configured telemetry destination",
    purpose: "Error reporting and observability integrations",
    receives:
      "Diagnostic and telemetry payloads according to the configured path; active destination, sanitization, access, and retention unverified",
  },
  {
    name: "Deepgram, Cartesia, AssemblyAI, Soniox, Fireworks AI, OpenAI, Gladia, ElevenLabs, Alibaba DashScope, Mistral, AquaVoice, Cohere",
    purpose: "Twelve optional speech-to-text vendor configurations",
    receives:
      "Audio and request context for enabled speech routes; supplied keys and routing determine available vendors, not this inventory",
  },
  {
    name: "OpenRouter and configured downstream model providers",
    purpose: "Optional hosted AI",
    receives:
      "Text, instructions, and request context for an enabled AI route; active downstream vendors, retention, and training terms unverified",
  },
  {
    name: "Pyannote",
    purpose: "Optional speaker diarization",
    receives:
      "Audio or an audio reference when the corresponding integration is enabled; deployed use and policies unverified",
  },
  {
    name: "Exa, Jina",
    purpose: "Optional research integrations",
    receives:
      "Queries and request context for enabled research routes; deployed use and provider policies unverified",
  },
  {
    name: "Loops, Resend",
    purpose: "Email integrations",
    receives:
      "Recipients, message contents, and delivery metadata for enabled email paths; sender settings and retention unverified",
  },
];

export const retentionRows = [
  {
    item: "Local notes and transcripts",
    retention:
      "On the device until removed; deleting an account does not itself delete local copies or exports",
  },
  {
    item: "Desktop audio files",
    retention:
      "Fallback default: Forever. Explicit or legacy settings can select don’t save, 1, 3, 7, or 30 days, or Forever; this applies to local audio only",
  },
  {
    item: "Uploaded transcription audio",
    retention:
      "Terminal callback attempts Supabase object deletion; lookup/deletion failures are logged. Best-effort cleanup, not an immediate-deletion guarantee",
  },
  {
    item: "Account deletion and hosted content",
    retention:
      "User-confirmed: same-day request handling or initiation, enabled and monitored jobs. Code uses pending acceptance and an extendable initial 24h 5m safety horizon, not a completion SLA. Loops deletion is a best-effort source path, not a confirmed active service",
  },
  {
    item: "Workspace retention",
    retention:
      "Optional capability-gated retention_days applies to shares and snapshots, not all local or hosted data",
  },
  {
    item: "Hosted retention (Playbook-confirmed)",
    retention:
      "Indefinite until user deletion or a request; no formal completion deadline. Not independently account-verified",
  },
  {
    item: "Provider-held copies, backups, and logs",
    retention:
      "Retention, expiry, deletion completion, and legal exceptions remain unconfirmed",
  },
];

export const certificationStatus = {
  claimed: [] as string[],
  planned:
    "SOC 2, ISO 27001, AIUC-1, and HIPAA/BAA programs are planned after we have operational evidence. This page does not claim any of them.",
  hostedTrustCenter:
    "A hosted trust center — the Vanta or Oneleet surface buyers expect — comes after those programs start. It will be a separate site, not this page.",
};

export const contractualDocs = [
  {
    label: "Privacy Policy",
    href: "/privacy/",
    note: "What we collect, local-first defaults, and processor list",
  },
  {
    label: "Terms of Service",
    href: "/terms/",
    note: "Contract for using Shots Founder Hub",
  },
  {
    label: "Data Processing Addendum",
    href: "mailto:team@playbookmedia.io?subject=Shots Founder Hub%20DPA",
    note: "Available on request for enterprise evaluations",
  },
];

export const shipsToday = [
  "Desktop app on macOS, Windows, and Linux",
  "Bot-free local capture from microphone and system audio",
  "Local SQLite as the source of truth, plus Markdown and other exports",
  "On-device transcription and local models, or bring-your-own API keys",
  "Optional end-to-end encrypted Cloud Sync",
  "Optional sharing and Cloud API & Connectors, each with a distinct data path",
];

export const shipsWithPartners = [
  "Team workspaces, domain SSO, and SCIM provisioning",
  "Org-wide sharing, retention, and consent policies",
  "Customer-hosted capture and a customer-controlled data plane",
];

export const pilotSteps = [
  {
    title: "Security review",
    body: "Forward this site to IT, security, and legal. The security page, privacy policy, and source-visible client are the packet. We answer questionnaires from the same facts — we will not invent certifications.",
  },
  {
    title: "Scoped pilot",
    body: "A founder-led trial with a named team, a defined data boundary (local-only, encrypted sync, or customer-hosted capture), and a success check you choose. No SDR queue.",
  },
  {
    title: "Rollout",
    body: "Expand seats and policies after the pilot. Workspace admin, SSO/SCIM, or a customer-hosted data plane land with the teams that need them — not as a surprise bot in every meeting.",
  },
];

export const proofStatus = {
  headline: "Named customer proof is not published yet",
  body: "We work directly with early enterprise partners. We will only publish a named or properly anonymized outcome after that partner approves the company context, constraint, deployment mode, and result. This page does not invent metrics or logos.",
};
