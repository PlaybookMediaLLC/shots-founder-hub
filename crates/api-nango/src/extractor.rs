use std::marker::PhantomData;

use anlg_api_auth::AuthContext;
use anlg_nango::{NangoClient, OwnedNangoHttpClient, OwnedNangoProxy};
use axum::{
    extract::FromRequestParts,
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
};

use crate::integrations::NangoIntegrationId;
use crate::store::ConnectionStore;

#[derive(Clone)]
pub struct NangoConnectionState {
    nango: NangoClient,
    store: ConnectionStore,
}

impl NangoConnectionState {
    pub fn new(nango: NangoClient, database: anlg_cloud_db::Database) -> Self {
        Self {
            nango,
            store: ConnectionStore::new(database),
        }
    }
    pub fn from_config(config: &crate::config::NangoConfig) -> Self {
        let nango = crate::config::build_nango_client(config).expect("failed to build NangoClient");
        Self::new(nango, config.database.clone())
    }

    pub async fn mark_reconnect_required(
        &self,
        integration_id: &str,
        connection_id: &str,
        error_description: &str,
    ) -> Result<(), NangoConnectionError> {
        self.store
            .mark_connection_refresh_failed(
                integration_id,
                connection_id,
                Some("provider_auth"),
                Some(error_description),
            )
            .await
            .map_err(|e| NangoConnectionError::Database(e.to_string()))
    }

    pub async fn build_http_client(
        &self,
        auth: &AuthContext,
        user_id: &str,
        integration_id: &str,
        connection_id: &str,
    ) -> Result<OwnedNangoHttpClient, NangoConnectionError> {
        let row = self
            .store
            .connection(auth, user_id, integration_id, Some(connection_id))
            .await
            .map_err(connection_error)?;

        match row {
            Some(row) if row.status == "reconnect_required" => {
                return Err(NangoConnectionError::ReconnectRequired(
                    integration_id.to_string(),
                ));
            }
            Some(_) => {}
            None => {
                return Err(NangoConnectionError::NotConnected(
                    integration_id.to_string(),
                ));
            }
        }

        let proxy = OwnedNangoProxy::new(
            &self.nango,
            integration_id.to_string(),
            connection_id.to_string(),
        );
        Ok(OwnedNangoHttpClient::new(proxy))
    }

    async fn get_connection_id(
        &self,
        auth: &AuthContext,
        user_id: &str,
        integration_id: &str,
    ) -> Result<String, NangoConnectionError> {
        #[cfg(debug_assertions)]
        if let Ok(connection_id) = std::env::var("DEV_NANGO_CONNECTION_ID")
            && !connection_id.is_empty()
        {
            return Ok(connection_id);
        }

        let row = self
            .store
            .lookup_connection(auth, user_id, integration_id)
            .await
            .map_err(connection_error)?;

        match row {
            Some(row) if row.status == "reconnect_required" => Err(
                NangoConnectionError::ReconnectRequired(integration_id.to_string()),
            ),
            Some(row) => Ok(row.connection_id),
            None => Err(NangoConnectionError::NotConnected(
                integration_id.to_string(),
            )),
        }
    }
}

fn connection_error(error: crate::error::NangoError) -> NangoConnectionError {
    match error {
        crate::error::NangoError::Auth(_) => NangoConnectionError::NotAuthenticated,
        _ => NangoConnectionError::Database("connection database request failed".into()),
    }
}

pub struct NangoConnection<I: NangoIntegrationId> {
    http: OwnedNangoHttpClient,
    _marker: PhantomData<I>,
}

impl<I: NangoIntegrationId> NangoConnection<I> {
    pub fn into_http(self) -> OwnedNangoHttpClient {
        self.http
    }
}

#[derive(Debug)]
pub enum NangoConnectionError {
    NotAuthenticated,
    NotConnected(String),
    ReconnectRequired(String),
    MissingState,
    Database(String),
}

impl IntoResponse for NangoConnectionError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            Self::NotAuthenticated => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "not authenticated".to_string(),
            ),
            Self::NotConnected(integration_id) => (
                StatusCode::BAD_REQUEST,
                "not_connected",
                format!("no connection found for integration: {}", integration_id),
            ),
            Self::ReconnectRequired(integration_id) => (
                StatusCode::FAILED_DEPENDENCY,
                "reconnect_required",
                format!(
                    "connection requires reconnect for integration: {}",
                    integration_id
                ),
            ),
            Self::MissingState => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_server_error",
                "NangoConnectionState not found in request extensions".to_string(),
            ),
            Self::Database(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_server_error",
                msg.clone(),
            ),
        };

        anlg_api_error::error_response(status, code, &message)
    }
}

impl std::fmt::Display for NangoConnectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAuthenticated => write!(f, "not authenticated"),
            Self::NotConnected(id) => write!(f, "not connected: {}", id),
            Self::ReconnectRequired(id) => write!(f, "reconnect required: {}", id),
            Self::MissingState => write!(f, "missing NangoConnectionState"),
            Self::Database(msg) => write!(f, "database error: {}", msg),
        }
    }
}

impl std::error::Error for NangoConnectionError {}

pub fn is_provider_auth_failure(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("(401")
        || lower.contains("status 401")
        || lower.contains("invalidauthenticationtoken")
        || lower.contains("invalid_credentials")
        || lower.contains("token is expired")
        || lower.contains("lifetime validation failed")
        || lower.contains("invalid_grant")
        || lower.contains("access_token_scope_insufficient")
        || lower.contains("insufficientpermissions")
        || lower.contains("could not refresh")
        || lower.contains("refresh access token")
}

impl<S: Send + Sync, I: NangoIntegrationId> FromRequestParts<S> for NangoConnection<I> {
    type Rejection = NangoConnectionError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let auth = parts
            .extensions
            .get::<AuthContext>()
            .ok_or(NangoConnectionError::NotAuthenticated)?;

        let nango_state = parts
            .extensions
            .get::<NangoConnectionState>()
            .ok_or(NangoConnectionError::MissingState)?;

        let connection_id = nango_state
            .get_connection_id(auth, &auth.claims.sub, I::ID)
            .await?;

        let proxy = OwnedNangoProxy::new(&nango_state.nango, I::ID.to_string(), connection_id);
        let http = OwnedNangoHttpClient::new(proxy);

        Ok(NangoConnection {
            http,
            _marker: PhantomData,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NangoConfig;
    use wiremock::MockServer;

    #[test]
    fn detects_graph_expired_token() {
        assert!(is_provider_auth_failure(
            "HTTP status client error (401 Unauthorized) for url (https://api.nango.dev/proxy/me/calendars)"
        ));
        assert!(is_provider_auth_failure(
            r#"{"error":{"code":"InvalidAuthenticationToken","message":"Lifetime validation failed, the token is expired."}}"#
        ));
        assert!(is_provider_auth_failure("invalid_grant"));
        assert!(is_provider_auth_failure(
            r#"API error (status 500): {"error":{"code":"InvalidAuthenticationToken","message":"Lifetime validation failed, the token is expired."}}"#
        ));
        assert!(is_provider_auth_failure(
            r#"API error (status 500): {"error":{"code":"invalid_credentials","message":"Could not refresh access token for connection"}}"#
        ));
        assert!(!is_provider_auth_failure(
            "HTTP status server error (500 Internal Server Error) for url (https://api.nango.dev/proxy/me/calendars)"
        ));
        assert!(!is_provider_auth_failure(
            "API error (status 500): Internal Server Error"
        ));
        assert!(!is_provider_auth_failure(
            "HTTP status client error (403 Forbidden) for url (https://api.nango.dev/proxy/me/calendars/AAMk)"
        ));
    }

    #[test]
    fn detects_missing_google_scopes_without_misclassifying_other_forbidden_errors() {
        assert!(is_provider_auth_failure(
            r#"API error (status 403): {"error":{"details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}],"status":"PERMISSION_DENIED"}}"#
        ));
        assert!(is_provider_auth_failure(
            r#"API error (status 403): {"error":{"errors":[{"reason":"insufficientPermissions"}]}}"#
        ));
        for reason in [
            "rateLimitExceeded",
            "quotaExceeded",
            "accessNotConfigured",
            "forbidden",
        ] {
            assert!(!is_provider_auth_failure(&format!(
                "API error (status 403): {{\"error\":{{\"reason\":\"{reason}\"}}}}"
            )));
        }
    }

    #[tokio::test]
    async fn connection_extractors_require_the_shots_identity() {
        let server = MockServer::start().await;
        let config = NangoConfig::for_test(&server.uri());
        let state = NangoConnectionState::from_config(&config);
        let auth = AuthContext {
            shots: None,
            token: "untrusted".into(),
            claims: serde_json::from_value(
                serde_json::json!({"sub":uuid::Uuid::new_v4(),"entitlements":[]}),
            )
            .unwrap(),
        };
        let error = state
            .get_connection_id(&auth, &auth.claims.sub, "google-calendar")
            .await
            .err()
            .unwrap();
        assert_eq!(error.into_response().status(), StatusCode::UNAUTHORIZED);
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}
