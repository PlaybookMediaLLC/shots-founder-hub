use std::path::Path;
use std::sync::OnceLock;

use envy::Error as EnvyError;
use serde::Deserialize;

use crate::service::Service;

fn default_port() -> u16 {
    3001
}

#[derive(Default, Deserialize)]
struct OptionalNangoEnv {
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    nango_api_base: Option<String>,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    nango_api_key: Option<String>,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    nango_webhook_signing_key: Option<String>,
}

#[derive(Default, Deserialize)]
struct OptionalPyannoteEnv {
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    pyannote_api_key: Option<String>,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    pyannote_api_base: Option<String>,
}

#[derive(Deserialize)]
pub struct Env {
    pub database_url: String,
    pub cloud_signing_key: String,
    #[serde(flatten)]
    pub r2: anlg_r2_storage::Config,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    pub shots_auth_url: Option<String>,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    pub founder_hub_mcp_url: Option<String>,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    shots_auth_service_token: Option<String>,
    #[serde(default)]
    pub anarlog_service: Service,
    #[serde(flatten)]
    pub upstreams: crate::proxy::Env,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    pub sentry_dsn: Option<String>,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    pub posthog_api_key: Option<String>,
    #[serde(default)]
    pub anarlog_attachment_backup_gc_enabled: bool,

    #[serde(flatten)]
    pub observability: crate::observability::Env,

    #[serde(flatten)]
    pub sync: anlg_api_sync::SyncEnv,
    #[serde(flatten)]
    nango: OptionalNangoEnv,
    #[serde(flatten)]
    pyannote: OptionalPyannoteEnv,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    pub exa_api_key: Option<String>,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    pub jina_api_key: Option<String>,

    #[serde(flatten)]
    pub resend: anlg_api_env::ResendEnv,

    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    openrouter_api_key: Option<String>,
    #[serde(flatten)]
    stt_api_keys: anlg_transcribe_proxy::SttApiKeysEnv,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    api_base_url: Option<String>,
    #[serde(default, deserialize_with = "anlg_api_env::filter_empty")]
    callback_secret: Option<String>,
}

// Raw environment resolved exactly once at startup: every optional integration
// group is either absent or completely validated, so router/state construction
// can consume the concrete groups without re-deriving or re-validating them.
pub struct RuntimeConfig {
    pub database: anlg_cloud_db::Database,
    pub storage: anlg_r2_storage::Storage,
    pub shots: Option<anlg_api_auth::ShotsAuth>,
    env: Env,
    pub nango: Option<anlg_api_env::NangoEnv>,
    pub pyannote: Option<anlg_api_env::PyannoteEnv>,
    pub research: Option<anlg_api_research::ResearchConfig>,
    pub llm: Option<anlg_llm_proxy::Env>,
    pub stt: Option<anlg_transcribe_proxy::Env>,
}

impl std::ops::Deref for RuntimeConfig {
    type Target = Env;

    fn deref(&self) -> &Self::Target {
        &self.env
    }
}

impl RuntimeConfig {
    pub(crate) fn resolve(mut env: Env) -> Result<Self, String> {
        if env.cloud_signing_key.len() < 32 {
            return Err("CLOUD_SIGNING_KEY must contain at least 32 bytes".into());
        }
        let database =
            anlg_cloud_db::Database::new(&env.database_url).map_err(|error| error.to_string())?;
        let storage = anlg_r2_storage::Storage::new(&env.r2).map_err(|error| error.to_string())?;
        let shots = env
            .shots_auth_url
            .as_deref()
            .map(|origin| {
                let authority = anlg_api_auth::ShotsAuthority::new(database.clone());
                Ok::<_, String>(
                    anlg_api_auth::ShotsAuth::new(
                        origin,
                        env.shots_auth_service_token
                            .as_deref()
                            .ok_or("SHOTS_AUTH_SERVICE_TOKEN is required with SHOTS_AUTH_URL")?,
                    )?
                    .with_authority(authority),
                )
            })
            .transpose()?;
        if shots.is_none() {
            return Err("SHOTS_AUTH_URL and SHOTS_AUTH_SERVICE_TOKEN are required".into());
        }
        let service = env.anarlog_service;
        env.upstreams.validate(service)?;
        let nango = if service.includes(Service::Core) {
            resolve_nango(&env.nango)?
        } else {
            None
        };
        let (llm, stt, pyannote, research) = if service.includes(Service::Ai) {
            let llm = anlg_llm_proxy::Env {
                openrouter_api_key: required_integration_value(
                    &env.openrouter_api_key,
                    "OPENROUTER_API_KEY",
                    "AI routes are enabled",
                )?,
            };
            let stt = anlg_transcribe_proxy::Env {
                stt: std::mem::take(&mut env.stt_api_keys),
                callback: anlg_transcribe_proxy::CallbackEnv {
                    api_base_url: required_integration_value(
                        &env.api_base_url,
                        "API_BASE_URL",
                        "AI routes are enabled",
                    )?,
                    callback_secret: env.callback_secret.clone(),
                },
            };
            (
                Some(llm),
                Some(stt),
                resolve_pyannote(&env.pyannote)?,
                resolve_research(&env.exa_api_key, &env.jina_api_key)?,
            )
        } else {
            (None, None, None, None)
        };

        if env.anarlog_attachment_backup_gc_enabled && !service.includes(Service::Core) {
            return Err(
                "ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED is only supported by core or all".to_string(),
            );
        }

        Ok(Self {
            database,
            storage,
            shots,
            env,
            nango,
            pyannote,
            research,
            llm,
            stt,
        })
    }

    pub(crate) fn auth_state(&self) -> anlg_api_auth::AuthState {
        anlg_api_auth::AuthState::new().with_shots(self.shots.clone())
    }
}

fn resolve_nango(nango: &OptionalNangoEnv) -> Result<Option<anlg_api_env::NangoEnv>, String> {
    let configured = nango.nango_api_base.is_some()
        || nango.nango_api_key.is_some()
        || nango.nango_webhook_signing_key.is_some();
    if !configured {
        return Ok(None);
    }

    Ok(Some(anlg_api_env::NangoEnv {
        nango_api_base: nango.nango_api_base.clone(),
        nango_api_key: required_integration_value(
            &nango.nango_api_key,
            "NANGO_API_KEY",
            "Nango is configured",
        )?,
        nango_webhook_signing_key: required_integration_value(
            &nango.nango_webhook_signing_key,
            "NANGO_WEBHOOK_SIGNING_KEY",
            "Nango is configured",
        )?,
    }))
}

fn resolve_pyannote(
    pyannote: &OptionalPyannoteEnv,
) -> Result<Option<anlg_api_env::PyannoteEnv>, String> {
    let configured = pyannote.pyannote_api_key.is_some() || pyannote.pyannote_api_base.is_some();
    if !configured {
        return Ok(None);
    }

    Ok(Some(anlg_api_env::PyannoteEnv {
        pyannote_api_key: required_integration_value(
            &pyannote.pyannote_api_key,
            "PYANNOTE_API_KEY",
            "pyannote is configured",
        )?,
        pyannote_api_base: pyannote
            .pyannote_api_base
            .clone()
            .unwrap_or_else(|| "https://api.pyannote.ai".to_string()),
    }))
}

fn resolve_research(
    exa_api_key: &Option<String>,
    jina_api_key: &Option<String>,
) -> Result<Option<anlg_api_research::ResearchConfig>, String> {
    match (exa_api_key, jina_api_key) {
        (None, None) => Ok(None),
        (Some(exa_api_key), Some(jina_api_key)) => Ok(Some(anlg_api_research::ResearchConfig {
            exa_api_key: exa_api_key.clone(),
            jina_api_key: jina_api_key.clone(),
        })),
        (Some(_), None) => Err("JINA_API_KEY is required when research is configured".to_string()),
        (None, Some(_)) => Err("EXA_API_KEY is required when research is configured".to_string()),
    }
}

fn required_integration_value(
    value: &Option<String>,
    variable: &str,
    condition: &str,
) -> Result<String, String> {
    value
        .clone()
        .ok_or_else(|| format!("{variable} is required when {condition}"))
}

static ENV: OnceLock<RuntimeConfig> = OnceLock::new();

pub fn env() -> &'static RuntimeConfig {
    ENV.get_or_init(|| {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .and_then(|p| p.parent())
            .unwrap_or(manifest_dir);

        let _ = dotenvy::from_path(repo_root.join(".env.cloud"));
        let _ = dotenvy::from_path(manifest_dir.join(".env"));
        let env: Env =
            envy::from_env().unwrap_or_else(|error| panic!("{}", format_env_error(error)));
        RuntimeConfig::resolve(env)
            .unwrap_or_else(|error| panic!("Failed to load environment: {error}"))
    })
}

fn format_env_error(error: EnvyError) -> String {
    match error {
        EnvyError::MissingValue(field) => {
            let env_var = field_name_to_env_var(field);
            format!("Failed to load environment: missing {env_var} (field: {field})")
        }
        other => format!("Failed to load environment: {other}"),
    }
}

fn field_name_to_env_var(field: &str) -> String {
    field
        .chars()
        .flat_map(|ch| ch.to_uppercase())
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn role_config(role: &str, extra: &[(&str, &str)]) -> Result<RuntimeConfig, String> {
        let mut values = vec![
            ("ANARLOG_SERVICE", role),
            ("DATABASE_URL", "postgres://localhost/founder_hub_test"),
            (
                "CLOUD_SIGNING_KEY",
                "test-signing-key-with-at-least-32-bytes",
            ),
            ("R2_ENDPOINT", "http://127.0.0.1:9000"),
            ("R2_BUCKET", "founder-hub-test"),
            ("R2_ACCESS_KEY_ID", "test"),
            ("R2_SECRET_ACCESS_KEY", "test"),
            ("SHOTS_AUTH_URL", "http://127.0.0.1:8090"),
            ("FOUNDER_HUB_MCP_URL", "http://127.0.0.1:3001/mcp"),
            (
                "SHOTS_AUTH_SERVICE_TOKEN",
                "test-service-token-with-at-least-thirty-two-bytes",
            ),
        ];
        values.extend_from_slice(extra);
        let raw = envy::from_iter(
            values
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>()
                .into_iter()
                .map(|(key, value)| (key.to_string(), value.to_string())),
        )
        .map_err(|error| error.to_string())?;
        RuntimeConfig::resolve(raw)
    }

    #[test]
    fn ai_configuration_remains_required_for_ai_and_combined_runtime() {
        for role in ["ai", "all"] {
            assert!(
                role_config(role, &[])
                    .err()
                    .unwrap()
                    .contains("OPENROUTER_API_KEY")
            );
            assert!(
                role_config(role, &[("OPENROUTER_API_KEY", "key")])
                    .err()
                    .unwrap()
                    .contains("API_BASE_URL")
            );
            let config = role_config(
                role,
                &[
                    ("OPENROUTER_API_KEY", "key"),
                    ("API_BASE_URL", "http://localhost:3001"),
                ],
            )
            .unwrap();
            assert!(config.llm.is_some());
            assert!(config.stt.is_some());
        }
    }

    #[test]
    fn unrelated_partial_integrations_do_not_configure_other_services() {
        let config = role_config(
            "sync",
            &[
                ("NANGO_API_KEY", "partial"),
                ("PYANNOTE_API_BASE", "partial"),
            ],
        )
        .unwrap();
        assert!(config.nango.is_none());
        assert!(config.pyannote.is_none());
    }

    #[test]
    fn only_core_can_own_cleanup_in_split_runtimes() {
        for role in ["ai", "sync"] {
            let error = role_config(
                role,
                &[
                    ("ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED", "true"),
                    ("OPENROUTER_API_KEY", "key"),
                    ("API_BASE_URL", "http://localhost:3001"),
                ],
            )
            .err()
            .unwrap();
            assert!(error.contains("only supported by core or all"));
        }
    }

    #[test]
    fn invalid_service_role_is_rejected() {
        assert!(role_config("unknown", &[]).is_err());
    }

    #[test]
    fn cloud_signing_key_cannot_be_empty() {
        assert!(
            role_config("core", &[("CLOUD_SIGNING_KEY", "")])
                .err()
                .unwrap()
                .contains("CLOUD_SIGNING_KEY")
        );
    }
}
