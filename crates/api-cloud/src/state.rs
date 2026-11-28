use anlg_agent_access::MeetingExport;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    oauth::OAuthResourceConfig,
    routes::{ApiKeyInfo, CloudApiSettings, SnapshotReceipt},
};

#[derive(Clone)]
pub struct CloudApiConfig {
    database: anlg_cloud_db::Database,
    oauth: OAuthResourceConfig,
}

impl CloudApiConfig {
    /// `resource` is the public MCP URL (FOUNDER_HUB_MCP_URL); Shots is the
    /// authorization server.
    pub fn new(
        database: anlg_cloud_db::Database,
        resource: &str,
        shots_origin: &str,
    ) -> Result<Self, String> {
        Ok(Self {
            database,
            oauth: OAuthResourceConfig::shots(resource, shots_origin)?,
        })
    }
}

#[derive(Clone)]
pub struct AppState {
    auth: anlg_api_auth::AuthState,
    config: CloudApiConfig,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum StoreError {
    #[error(transparent)]
    Database(#[from] anlg_cloud_db::Error),
    #[error("cloud data response was invalid: {0}")]
    InvalidResponse(#[from] serde_json::Error),
}

#[derive(Deserialize)]
struct SnapshotRow {
    content_json: MeetingExport,
}

#[derive(Deserialize)]
pub(crate) struct VerifiedKey {
    pub user_id: String,
    pub status: String,
}

#[derive(Deserialize)]
pub(crate) struct ShotsKeyBinding {
    pub user_id: String,
    pub shots_user_id: String,
    pub shots_session_id: String,
}

#[derive(Deserialize)]
pub(crate) struct VerifiedUser {
    pub status: String,
}

impl AppState {
    pub(crate) fn shots(&self) -> Option<&anlg_api_auth::ShotsAuth> {
        self.auth.shots()
    }
    pub fn with_auth(mut self, auth: anlg_api_auth::AuthState) -> Self {
        self.auth = auth;
        self
    }

    pub fn new(config: CloudApiConfig) -> Self {
        let auth = anlg_api_auth::AuthState::new();
        Self { auth, config }
    }

    pub(crate) fn oauth(&self) -> &OAuthResourceConfig {
        &self.config.oauth
    }

    pub(crate) async fn verify_oauth_token(
        &self,
        token: &str,
    ) -> Result<anlg_api_auth::AuthContext, anlg_api_auth::OAuthTokenError> {
        if let Some(shots) = self.shots() {
            return shots
                .connector_session(token)
                .await
                .map_err(|_| anlg_api_auth::OAuthTokenError::Invalid);
        }
        Err(anlg_api_auth::OAuthTokenError::Invalid)
    }

    pub(crate) async fn verify_session_token(
        &self,
        token: &str,
    ) -> Result<anlg_api_auth::AuthContext, anlg_api_auth::AuthError> {
        self.auth.authenticate(token).await
    }

    async fn rpc<T: DeserializeOwned>(
        &self,
        function: &str,
        body: impl Serialize,
    ) -> Result<T, StoreError> {
        self.config
            .database
            .rpc(&anlg_cloud_db::Principal::Service, function, &body)
            .await
            .map_err(StoreError::from)
    }

    pub(crate) async fn get_settings(&self, user_id: &str) -> Result<CloudApiSettings, StoreError> {
        let mut rows: Vec<CloudApiSettings> = self
            .rpc(
                "get_cloud_api_settings",
                serde_json::json!({ "p_actor_user_id": user_id }),
            )
            .await?;
        rows.pop().ok_or_else(|| {
            StoreError::InvalidResponse(serde_json::Error::io(std::io::Error::other(
                "settings row missing",
            )))
        })
    }

    pub(crate) async fn set_enabled(
        &self,
        user_id: &str,
        enabled: bool,
    ) -> Result<CloudApiSettings, StoreError> {
        let mut rows: Vec<CloudApiSettings> = self
            .rpc(
                "set_cloud_api_enabled",
                serde_json::json!({
                    "p_actor_user_id": user_id,
                    "p_enabled": enabled,
                }),
            )
            .await?;
        rows.pop().ok_or_else(|| {
            StoreError::InvalidResponse(serde_json::Error::io(std::io::Error::other(
                "settings row missing",
            )))
        })
    }

    pub(crate) async fn publish_snapshot(
        &self,
        auth: &anlg_api_auth::AuthContext,
        session_id: &str,
        content: &MeetingExport,
        source_workspace_id: Option<&str>,
    ) -> Result<SnapshotReceipt, StoreError> {
        let mut body = serde_json::json!({
            "p_actor_user_id": auth.claims.sub,
            "p_session_id": session_id,
            "p_content_json": content,
        });
        let function = if auth.shots.is_some() {
            body["p_source_workspace_id"] = serde_json::json!(source_workspace_id);
            "publish_shots_cloud_api_snapshot"
        } else {
            "publish_cloud_api_snapshot"
        };
        let mut rows: Vec<SnapshotReceipt> = self.rpc(function, body).await?;
        rows.pop().ok_or_else(|| {
            StoreError::InvalidResponse(serde_json::Error::io(std::io::Error::other(
                "snapshot receipt missing",
            )))
        })
    }

    pub(crate) async fn delete_snapshot(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<bool, StoreError> {
        self.rpc(
            "delete_cloud_api_snapshot",
            serde_json::json!({
                "p_actor_user_id": user_id,
                "p_session_id": session_id,
            }),
        )
        .await
    }

    pub(crate) async fn list_snapshots(
        &self,
        user_id: &str,
        query: Option<&str>,
        series_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<MeetingExport>, StoreError> {
        let rows: Vec<SnapshotRow> = self
            .rpc(
                "list_cloud_api_snapshots",
                serde_json::json!({
                    "p_user_id": user_id,
                    "p_query": query,
                    "p_series_id": series_id,
                    "p_limit": limit,
                    "p_offset": offset,
                }),
            )
            .await?;
        Ok(rows.into_iter().map(|row| row.content_json).collect())
    }

    pub(crate) async fn read_snapshot(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<MeetingExport>, StoreError> {
        let mut rows: Vec<SnapshotRow> = self
            .rpc(
                "read_cloud_api_snapshot",
                serde_json::json!({
                    "p_user_id": user_id,
                    "p_session_id": session_id,
                }),
            )
            .await?;
        Ok(rows.pop().map(|row| row.content_json))
    }

    pub(crate) async fn create_key(
        &self,
        auth: &anlg_api_auth::AuthContext,
        id: &str,
        name: &str,
        key_hash: &str,
        key_prefix: &str,
    ) -> Result<ApiKeyInfo, StoreError> {
        let mut body = serde_json::json!({
            "p_actor_user_id": auth.claims.sub,
            "p_id": id,
            "p_name": name,
            "p_key_hash": key_hash,
            "p_key_prefix": key_prefix,
        });
        let function = if let Some(shots) = &auth.shots {
            body["p_shots_user_id"] = serde_json::json!(shots.user.id);
            body["p_shots_session_id"] = serde_json::json!(shots.session_id);
            "create_shots_cloud_api_key"
        } else {
            "create_cloud_api_key"
        };
        let mut rows: Vec<ApiKeyInfo> = self.rpc(function, body).await?;
        rows.pop().ok_or_else(|| {
            StoreError::InvalidResponse(serde_json::Error::io(std::io::Error::other(
                "API key row missing",
            )))
        })
    }

    pub(crate) async fn list_keys(&self, user_id: &str) -> Result<Vec<ApiKeyInfo>, StoreError> {
        self.rpc(
            "list_cloud_api_keys",
            serde_json::json!({ "p_actor_user_id": user_id }),
        )
        .await
    }

    pub(crate) async fn revoke_key(&self, user_id: &str, key_id: &str) -> Result<bool, StoreError> {
        self.rpc(
            "revoke_cloud_api_key",
            serde_json::json!({
                "p_actor_user_id": user_id,
                "p_key_id": key_id,
            }),
        )
        .await
    }

    pub(crate) async fn verify_key(
        &self,
        key_hash: &str,
    ) -> Result<Option<VerifiedKey>, StoreError> {
        let mut rows: Vec<VerifiedKey> = self
            .rpc(
                if self.shots().is_some() {
                    "verify_shots_cloud_api_key"
                } else {
                    "verify_cloud_api_key"
                },
                serde_json::json!({ "p_key_hash": key_hash }),
            )
            .await?;
        Ok(rows.pop())
    }

    pub(crate) async fn lookup_shots_key(
        &self,
        key_hash: &str,
    ) -> Result<Option<ShotsKeyBinding>, StoreError> {
        let mut rows: Vec<ShotsKeyBinding> = self
            .rpc(
                "lookup_shots_cloud_api_key",
                serde_json::json!({ "p_key_hash": key_hash }),
            )
            .await?;
        Ok(rows.pop())
    }

    pub(crate) async fn verify_user(&self, user_id: &str) -> Result<VerifiedUser, StoreError> {
        let mut rows: Vec<VerifiedUser> = self
            .rpc(
                "verify_cloud_api_user",
                serde_json::json!({ "p_user_id": user_id }),
            )
            .await?;
        rows.pop().ok_or_else(|| {
            StoreError::InvalidResponse(serde_json::Error::io(std::io::Error::other(
                "cloud API user verification row missing",
            )))
        })
    }
}
