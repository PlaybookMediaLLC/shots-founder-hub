use serde::Deserialize;

const DEFAULT_TOKEN_TTL_SECONDS: u64 = 15 * 60;
const MIN_TOKEN_TTL_SECONDS: u64 = 60;
const MAX_TOKEN_TTL_SECONDS: u64 = 60 * 60;

#[derive(Clone, Deserialize)]
pub struct SyncEnv {
    #[serde(default)]
    pub sqlitecloud_project_url: Option<String>,
    #[serde(default)]
    pub sqlitecloud_token_issuer_api_key: Option<String>,
    #[serde(default)]
    pub anarlog_cloudsync_e2ee_database_id: Option<String>,
    #[serde(default)]
    pub anarlog_cloudsync_database_id: Option<String>,
    #[serde(default)]
    pub anarlog_cloudsync_protocol_mode: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub anarlog_cloudsync_token_ttl_seconds: Option<u64>,
    #[serde(default)]
    pub anarlog_cloudsync_desktop_transport: Option<String>,
}

/// Which transport `/sync/token` hands to desktop clients that can accept
/// either. Per-account rows in `sync_transport_overrides` win over this default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum CloudsyncTransport {
    #[default]
    SqliteSync,
    Replica,
}

impl CloudsyncTransport {
    pub(crate) fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("sqlite_sync") => Ok(Self::SqliteSync),
            Some("replica") => Ok(Self::Replica),
            Some(_) => Err(
                "ANARLOG_CLOUDSYNC_DESKTOP_TRANSPORT must be sqlite_sync or replica".to_string(),
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum CloudsyncProtocolMode {
    Dual,
    E2eeOnly,
    #[default]
    E2eeEnforced,
}

impl CloudsyncProtocolMode {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("e2ee_enforced") => Ok(Self::E2eeEnforced),
            Some("dual") => Ok(Self::Dual),
            Some("e2ee_only") => Ok(Self::E2eeOnly),
            Some(_) => Err(
                "ANARLOG_CLOUDSYNC_PROTOCOL_MODE must be dual, e2ee_only, or e2ee_enforced"
                    .to_string(),
            ),
        }
    }
}

fn deserialize_optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(|value| value.parse().map_err(serde::de::Error::custom))
        .transpose()
}

#[derive(Clone)]
pub(crate) struct CloudsyncIssuer {
    pub(crate) project_url: String,
    pub(crate) token_issuer_api_key: String,
    pub(crate) database_id: String,
}

#[derive(Clone)]
pub struct SyncConfig {
    pub(crate) issuer: Option<CloudsyncIssuer>,
    pub(crate) legacy_database_id: Option<String>,
    pub(crate) protocol_mode: CloudsyncProtocolMode,
    pub(crate) desktop_transport: CloudsyncTransport,
    pub(crate) token_ttl_seconds: u64,
    pub(crate) database: anlg_cloud_db::Database,
    pub(crate) storage: anlg_r2_storage::Storage,
    pub(crate) signing_key: String,
}

#[derive(Clone)]
pub struct ReplicaConfig {
    pub(crate) database: anlg_cloud_db::Database,
    pub(crate) storage: anlg_r2_storage::Storage,
    pub(crate) signing_key: String,
}

#[derive(Clone)]
pub struct SharedNotesConfig {
    pub(crate) database: anlg_cloud_db::Database,
    pub(crate) storage: anlg_r2_storage::Storage,
    pub(crate) handoff_signing_key: String,
    pub(crate) loops_api_key: Option<String>,
    pub(crate) loops_api_base: Option<reqwest::Url>,
    pub(crate) resend_api_key: Option<String>,
    pub(crate) resend_api_base: Option<reqwest::Url>,
    pub(crate) resend_from_email: Option<String>,
}

impl SharedNotesConfig {
    pub fn new(
        database: anlg_cloud_db::Database,
        storage: anlg_r2_storage::Storage,
        handoff_signing_key: String,
    ) -> Result<Self, String> {
        if handoff_signing_key.len() < 32 {
            return Err("Handoff signing key must contain at least 32 bytes".into());
        }
        Ok(Self {
            database,
            storage,
            handoff_signing_key,
            loops_api_key: None,
            loops_api_base: None,
            resend_api_key: None,
            resend_api_base: None,
            resend_from_email: None,
        })
    }

    pub fn with_resend_email(
        mut self,
        api_key: impl Into<String>,
        from_email: impl Into<String>,
    ) -> Result<Self, String> {
        let api_key = api_key.into();
        if api_key.trim().is_empty() {
            return Err("RESEND_API_KEY is required for shared note email".to_string());
        }
        let from_email = from_email.into();
        if !is_email_address(&from_email) {
            return Err(
                "RESEND_FROM_EMAIL must be a valid email address for shared note email".to_string(),
            );
        }
        self.resend_api_key = Some(api_key);
        self.resend_from_email = Some(from_email);
        Ok(self)
    }

    pub fn with_invitation_email(
        mut self,
        loops_api_key: impl Into<String>,
    ) -> Result<Self, String> {
        let loops_api_key = loops_api_key.into();
        if loops_api_key.trim().is_empty() {
            return Err("LOOPS_KEY is required for shared note invitations".to_string());
        }
        self.loops_api_key = Some(loops_api_key);
        Ok(self)
    }
}

fn is_email_address(value: &str) -> bool {
    value.len() <= 320
        && value.trim() == value
        && !value.chars().any(char::is_control)
        && value
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'))
}

impl SyncConfig {
    pub fn new(
        project_url: impl Into<String>,
        token_issuer_api_key: impl Into<String>,
        database_id: impl Into<String>,
        database: anlg_cloud_db::Database,
        storage: anlg_r2_storage::Storage,
        signing_key: String,
    ) -> Result<Self, String> {
        if signing_key.len() < 32 {
            return Err("Cloud signing key must contain at least 32 bytes".into());
        }
        Ok(Self {
            issuer: Some(CloudsyncIssuer {
                project_url: validate_project_url(project_url.into())?,
                token_issuer_api_key: token_issuer_api_key.into(),
                database_id: database_id.into(),
            }),
            legacy_database_id: None,
            protocol_mode: CloudsyncProtocolMode::E2eeEnforced,
            desktop_transport: CloudsyncTransport::SqliteSync,
            token_ttl_seconds: DEFAULT_TOKEN_TTL_SECONDS,
            database,
            storage,
            signing_key,
        })
    }

    pub fn replica_only(config: ReplicaConfig) -> Self {
        Self {
            issuer: None,
            legacy_database_id: None,
            protocol_mode: CloudsyncProtocolMode::E2eeEnforced,
            desktop_transport: CloudsyncTransport::Replica,
            token_ttl_seconds: DEFAULT_TOKEN_TTL_SECONDS,
            database: config.database,
            storage: config.storage,
            signing_key: config.signing_key,
        }
    }

    pub fn with_token_ttl_seconds(mut self, token_ttl_seconds: u64) -> Result<Self, String> {
        validate_token_ttl(token_ttl_seconds)?;
        self.token_ttl_seconds = token_ttl_seconds;
        Ok(self)
    }

    pub(crate) fn with_desktop_transport(mut self, transport: CloudsyncTransport) -> Self {
        self.desktop_transport = transport;
        self
    }

    pub(crate) fn with_protocol_mode(
        mut self,
        protocol_mode: CloudsyncProtocolMode,
        legacy_database_id: Option<String>,
    ) -> Result<Self, String> {
        validate_protocol_databases(
            &self
                .issuer
                .as_ref()
                .ok_or("CloudSync issuer is not configured")?
                .database_id,
            legacy_database_id.as_deref(),
            protocol_mode,
        )?;
        self.legacy_database_id = legacy_database_id;
        self.protocol_mode = protocol_mode;
        Ok(self)
    }

    pub fn from_env(
        env: &SyncEnv,
        database: anlg_cloud_db::Database,
        storage: anlg_r2_storage::Storage,
        signing_key: String,
    ) -> Result<Option<Self>, String> {
        let project_url = nonempty(env.sqlitecloud_project_url.as_deref());
        let token_issuer_api_key = nonempty(env.sqlitecloud_token_issuer_api_key.as_deref());
        let database_id = nonempty(env.anarlog_cloudsync_e2ee_database_id.as_deref());
        let legacy_database_id = nonempty(env.anarlog_cloudsync_database_id.as_deref());
        let protocol_mode_value = nonempty(env.anarlog_cloudsync_protocol_mode.as_deref());
        let desktop_transport_value = nonempty(env.anarlog_cloudsync_desktop_transport.as_deref());

        if project_url.is_none()
            && token_issuer_api_key.is_none()
            && database_id.is_none()
            && legacy_database_id.is_none()
            && protocol_mode_value.is_none()
            && desktop_transport_value.is_none()
        {
            return Ok(None);
        }
        let project_url = project_url.ok_or_else(|| {
            "SQLITECLOUD_PROJECT_URL is required when CloudSync token exchange is configured"
                .to_string()
        })?;
        let token_issuer_api_key = token_issuer_api_key.ok_or_else(|| {
            "SQLITECLOUD_TOKEN_ISSUER_API_KEY is required when CloudSync token exchange is configured"
                .to_string()
        })?;
        let database_id = database_id.ok_or_else(|| {
            "ANARLOG_CLOUDSYNC_E2EE_DATABASE_ID is required when CloudSync token exchange is configured"
                .to_string()
        })?;
        let protocol_mode = CloudsyncProtocolMode::parse(protocol_mode_value.as_deref())?;
        let desktop_transport = CloudsyncTransport::parse(desktop_transport_value.as_deref())?;
        let token_ttl_seconds = env
            .anarlog_cloudsync_token_ttl_seconds
            .unwrap_or(DEFAULT_TOKEN_TTL_SECONDS);
        validate_token_ttl(token_ttl_seconds)?;

        Ok(Some(
            Self::new(
                project_url,
                token_issuer_api_key,
                database_id,
                database,
                storage,
                signing_key,
            )?
            .with_protocol_mode(protocol_mode, legacy_database_id)?
            .with_token_ttl_seconds(token_ttl_seconds)?
            .with_desktop_transport(desktop_transport),
        ))
    }

    pub(crate) fn replica_config(&self) -> ReplicaConfig {
        ReplicaConfig {
            database: self.database.clone(),
            storage: self.storage.clone(),
            signing_key: self.signing_key.clone(),
        }
    }
}

impl ReplicaConfig {
    pub fn new(
        database: anlg_cloud_db::Database,
        storage: anlg_r2_storage::Storage,
        signing_key: String,
    ) -> Result<Self, String> {
        if signing_key.len() < 32 {
            return Err("Cloud signing key must contain at least 32 bytes".into());
        }
        Ok(Self {
            database,
            storage,
            signing_key,
        })
    }
}

fn validate_protocol_databases(
    database_id: &str,
    legacy_database_id: Option<&str>,
    protocol_mode: CloudsyncProtocolMode,
) -> Result<(), String> {
    if legacy_database_id == Some(database_id) {
        return Err(
            "ANARLOG_CLOUDSYNC_DATABASE_ID must differ from ANARLOG_CLOUDSYNC_E2EE_DATABASE_ID"
                .to_string(),
        );
    }
    if protocol_mode == CloudsyncProtocolMode::Dual && legacy_database_id.is_none() {
        return Err("ANARLOG_CLOUDSYNC_DATABASE_ID is required in dual protocol mode".to_string());
    }
    Ok(())
}

fn validate_project_url(value: String) -> Result<String, String> {
    let url = reqwest::Url::parse(&value)
        .map_err(|_| "SQLITECLOUD_PROJECT_URL must be a valid URL".to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "SQLITECLOUD_PROJECT_URL must include a host".to_string())?;
    if url.scheme() != "https" || !host.ends_with(".sqlite.cloud") {
        return Err(
            "SQLITECLOUD_PROJECT_URL must be an HTTPS SQLite Cloud project URL".to_string(),
        );
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("SQLITECLOUD_PROJECT_URL must contain only the project origin".to_string());
    }

    Ok(url.origin().ascii_serialization())
}

fn validate_token_ttl(token_ttl_seconds: u64) -> Result<(), String> {
    if !(MIN_TOKEN_TTL_SECONDS..=MAX_TOKEN_TTL_SECONDS).contains(&token_ttl_seconds) {
        return Err(format!(
            "ANARLOG_CLOUDSYNC_TOKEN_TTL_SECONDS must be between {MIN_TOKEN_TTL_SECONDS} and {MAX_TOKEN_TTL_SECONDS}"
        ));
    }
    Ok(())
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(project_url: &str, token_ttl_seconds: Option<u64>) -> SyncEnv {
        SyncEnv {
            sqlitecloud_project_url: Some(project_url.to_string()),
            sqlitecloud_token_issuer_api_key: Some("issuer-key".to_string()),
            anarlog_cloudsync_e2ee_database_id: Some("database-id".to_string()),
            anarlog_cloudsync_database_id: None,
            anarlog_cloudsync_protocol_mode: None,
            anarlog_cloudsync_token_ttl_seconds: token_ttl_seconds,
            anarlog_cloudsync_desktop_transport: None,
        }
    }

    #[test]
    fn default_config_is_enforced_e2ee_over_sqlite_sync() {
        let config = config(&env("https://project.region.gateway.sqlite.cloud/", None))
            .unwrap()
            .unwrap();

        assert_eq!(config.protocol_mode, CloudsyncProtocolMode::E2eeEnforced);
        assert_eq!(config.desktop_transport, CloudsyncTransport::SqliteSync);
        assert!(config.legacy_database_id.is_none());
        assert_eq!(
            config.issuer.as_ref().unwrap().project_url,
            "https://project.region.gateway.sqlite.cloud"
        );
        assert_eq!(config.token_ttl_seconds, DEFAULT_TOKEN_TTL_SECONDS);
    }

    #[test]
    fn accepts_only_known_desktop_transports() {
        let mut sync_env = env("https://project.region.gateway.sqlite.cloud/", None);
        sync_env.anarlog_cloudsync_desktop_transport = Some("replica".to_string());
        let replica = config(&sync_env).unwrap().unwrap();
        assert_eq!(replica.desktop_transport, CloudsyncTransport::Replica);

        sync_env.anarlog_cloudsync_desktop_transport = Some(" sqlite_sync ".to_string());
        let sqlite_sync = config(&sync_env).unwrap().unwrap();
        assert_eq!(
            sqlite_sync.desktop_transport,
            CloudsyncTransport::SqliteSync
        );

        sync_env.anarlog_cloudsync_desktop_transport = Some("witness".to_string());
        assert!(config(&sync_env).is_err());
    }

    #[test]
    fn validates_protocol_mode_and_database_ids() {
        for (case, mode, legacy_database_id, expect_ok) in [
            ("dual requires a legacy database", "dual", None, false),
            (
                "dual rejects the e2ee database as legacy",
                "dual",
                Some("database-id"),
                false,
            ),
            (
                "e2ee_only rejects the e2ee database as legacy",
                "e2ee_only",
                Some("database-id"),
                false,
            ),
            (
                "e2ee_enforced rejects the e2ee database as legacy",
                "e2ee_enforced",
                Some("database-id"),
                false,
            ),
            ("e2ee_only is supported", "e2ee_only", None, true),
            ("e2ee_enforced is supported", "e2ee_enforced", None, true),
            ("unknown protocol modes are rejected", "legacy", None, false),
        ] {
            let mut sync_env = env("https://project.region.gateway.sqlite.cloud/", None);
            sync_env.anarlog_cloudsync_protocol_mode = Some(mode.to_string());
            sync_env.anarlog_cloudsync_database_id = legacy_database_id.map(ToString::to_string);

            assert_eq!(config(&sync_env).is_ok(), expect_ok, "{case}");
        }

        let mut sync_env = env("https://project.region.gateway.sqlite.cloud/", None);
        sync_env.anarlog_cloudsync_protocol_mode = Some("dual".to_string());
        sync_env.anarlog_cloudsync_database_id = Some("legacy-database-id".to_string());
        let config = config(&sync_env).unwrap().unwrap();
        assert_eq!(config.protocol_mode, CloudsyncProtocolMode::Dual);
        assert_eq!(
            config.legacy_database_id.as_deref(),
            Some("legacy-database-id")
        );
    }

    fn config(env: &SyncEnv) -> Result<Option<SyncConfig>, String> {
        SyncConfig::from_env(
            env,
            crate::test_support::database(),
            crate::test_support::storage(),
            "test-signing-key-at-least-thirty-two-bytes".into(),
        )
    }

    #[test]
    fn rejects_unsafe_project_urls_and_out_of_range_ttls() {
        for (case, project_url, token_ttl_seconds) in [
            (
                "non-https project URLs are rejected",
                "http://project.gateway.sqlite.cloud",
                None,
            ),
            (
                "non-SQLite Cloud project URLs are rejected",
                "https://example.com",
                None,
            ),
            (
                "token TTL below the minimum is rejected",
                "https://project.gateway.sqlite.cloud",
                Some(MIN_TOKEN_TTL_SECONDS - 1),
            ),
            (
                "token TTL above the maximum is rejected",
                "https://project.gateway.sqlite.cloud",
                Some(MAX_TOKEN_TTL_SECONDS + 1),
            ),
        ] {
            assert!(
                config(&env(project_url, token_ttl_seconds)).is_err(),
                "{case}"
            );
        }
    }

    #[test]
    fn signing_keys_are_required() {
        assert!(
            SharedNotesConfig::new(
                crate::test_support::database(),
                crate::test_support::storage(),
                "short".into()
            )
            .is_err()
        );
        assert!(
            ReplicaConfig::new(
                crate::test_support::database(),
                crate::test_support::storage(),
                "short".into()
            )
            .is_err()
        );
    }
}
