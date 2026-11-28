"""Select only the given API service's runtime secrets; never print values."""

SHARED = {
    "DATABASE_URL",
    "CLOUD_SIGNING_KEY",
    "R2_ENDPOINT",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "SENTRY_DSN",
    "POSTHOG_API_KEY",
    "RUST_LOG",
    "OTEL_SERVICE_NAME",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "HONEYCOMB_API_KEY",
    "HONEYCOMB_API_ENDPOINT",
    "HONEYCOMB_DATASET",
    "HONEYCOMB_UI_BASE_URL",
    "HONEYCOMB_UI_TEAM",
    "HONEYCOMB_UI_ENVIRONMENT",
}
AI = {
    "OPENROUTER_API_KEY",
    "API_BASE_URL",
    "CALLBACK_SECRET",
    "EXA_API_KEY",
    "JINA_API_KEY",
    "PYANNOTE_API_KEY",
    "PYANNOTE_API_BASE",
    "DEEPGRAM_API_KEY",
    "CARTESIA_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "SONIOX_API_KEY",
    "FIREWORKS_API_KEY",
    "OPENAI_API_KEY",
    "GLADIA_API_KEY",
    "ELEVENLABS_API_KEY",
    "DASHSCOPE_API_KEY",
    "MISTRAL_API_KEY",
    "AQUAVOICE_API_KEY",
    "COHERE_API_KEY",
}
SHOTS = {"SHOTS_AUTH_URL", "SHOTS_AUTH_SERVICE_TOKEN"}
CORE = {
    "NANGO_API_BASE",
    "NANGO_API_KEY",
    "NANGO_WEBHOOK_SIGNING_KEY",
    "GOOGLE_DRIVE_PICKER_REDIRECT_URI",
}
SYNC = {"RESEND_API_KEY", "RESEND_FROM_EMAIL"}
ROLES = {"ai": AI, "sync": SYNC, "core": CORE | SYNC}


def select(service, secrets):
    if service not in {*ROLES, "all", "gateway"}:
        raise ValueError("Unknown API service")
    allowed = SHARED | SHOTS | ROLES.get(service, AI | CORE | SYNC)
    if service in {"sync", "all", "gateway"}:
        allowed.add("FOUNDER_HUB_MCP_URL")
    values = {}
    for secret in secrets:
        key, value = secret["key"], secret.get("value", "")
        if key not in allowed:
            continue
        if key in values and values[key] != value:
            raise ValueError(f"Conflicting secret: {key}")
        values[key] = value
    required = {
        "DATABASE_URL",
        "CLOUD_SIGNING_KEY",
        "R2_ENDPOINT",
        "R2_BUCKET",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
    } | SHOTS
    if service in {"sync", "all", "gateway"}:
        required.add("FOUNDER_HUB_MCP_URL")
    if service in {"ai", "all", "gateway"}:
        required |= {"OPENROUTER_API_KEY", "API_BASE_URL", "CALLBACK_SECRET"}
        if not any(
            values.get(key)
            for key in AI
            - {
                "OPENROUTER_API_KEY",
                "EXA_API_KEY",
                "JINA_API_KEY",
                "PYANNOTE_API_KEY",
                "API_BASE_URL",
                "CALLBACK_SECRET",
                "PYANNOTE_API_BASE",
            }
        ):
            raise ValueError("At least one transcription provider is required")
    if service in {"sync", "core", "all", "gateway"}:
        required |= {"RESEND_API_KEY", "RESEND_FROM_EMAIL"}
    missing = sorted(key for key in required if not values.get(key))
    if missing:
        raise ValueError("Missing required service secrets: " + ", ".join(missing))
    return values
