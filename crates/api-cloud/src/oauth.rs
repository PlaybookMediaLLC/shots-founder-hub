use axum::{Json, Router, extract::State, routing::get};
use serde::Serialize;

use crate::state::AppState;

pub(crate) const SHOTS_SCOPES: &[&str] = &["founder-hub:meetings:read", "offline_access"];
pub(crate) const MCP_RESOURCE: &str = "https://api.anarlog.so/mcp";

#[derive(Clone)]
pub(crate) struct OAuthResourceConfig {
    resource: String,
    authorization_server: String,
    resource_metadata: String,
}

#[derive(Serialize)]
struct ProtectedResourceMetadata {
    resource: String,
    authorization_servers: [String; 1],
    #[serde(skip_serializing_if = "Option::is_none")]
    scopes_supported: Option<&'static [&'static str]>,
    bearer_methods_supported: [&'static str; 1],
}

impl OAuthResourceConfig {
    pub(crate) fn shots(resource: &str, shots_origin: &str) -> Result<Self, String> {
        let resource_url = reqwest::Url::parse(resource)
            .map_err(|_| "MCP OAuth resource must be an absolute URL".to_string())?;
        let local = matches!(
            resource_url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]")
        );
        if !(resource_url.scheme() == "https" || resource_url.scheme() == "http" && local)
            || !resource_url.username().is_empty()
            || resource_url.password().is_some()
            || resource_url.path() != "/mcp"
            || resource_url.query().is_some()
            || resource_url.fragment().is_some()
        {
            return Err(
                "MCP OAuth resource must be an HTTPS /mcp URL (HTTP only on loopback), without credentials, query or fragment".to_string(),
            );
        }
        let origin = resource_url.origin().ascii_serialization();
        let resource_path = resource_url.path().trim_start_matches('/');
        let resource_metadata = if resource_path.is_empty() {
            format!("{origin}/.well-known/oauth-protected-resource")
        } else {
            format!("{origin}/.well-known/oauth-protected-resource/{resource_path}")
        };

        Ok(Self {
            resource: resource_url.to_string().trim_end_matches('/').to_string(),
            authorization_server: format!("{}/api/auth", shots_origin.trim_end_matches('/')),
            resource_metadata,
        })
    }

    pub(crate) fn scopes(&self) -> &'static [&'static str] {
        SHOTS_SCOPES
    }

    pub(crate) fn resource(&self) -> &str {
        &self.resource
    }

    pub(crate) fn authorization_server(&self) -> &str {
        &self.authorization_server
    }

    pub(crate) fn challenge(&self, error: Option<(&str, &str)>) -> String {
        let mut challenge = format!("Bearer resource_metadata=\"{}\"", self.resource_metadata);
        if !self.scopes().is_empty() {
            challenge.push_str(&format!(", scope=\"{}\"", self.scopes().join(" ")));
        }
        if let Some((error, description)) = error {
            challenge.push_str(&format!(
                ", error=\"{error}\", error_description=\"{description}\""
            ));
        }
        challenge
    }
}

pub fn metadata_router(state: AppState) -> Router {
    let router = Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(protected_resource_metadata),
        );
    router.with_state(state)
}

async fn protected_resource_metadata(
    State(state): State<AppState>,
) -> Json<ProtectedResourceMetadata> {
    let oauth = state.oauth();
    Json(ProtectedResourceMetadata {
        resource: oauth.resource().to_string(),
        authorization_servers: [oauth.authorization_server().to_string()],
        scopes_supported: (!oauth.scopes().is_empty()).then_some(oauth.scopes()),
        bearer_methods_supported: ["header"],
    })
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;
    use crate::{CloudApiConfig, state::AppState};

    #[tokio::test]
    async fn publishes_protected_resource_metadata_at_root_and_path_locations() {
        let state = AppState::new(
            CloudApiConfig::new(
                anlg_cloud_db::Database::new("postgres://127.0.0.1:1/unavailable").unwrap(),
                "https://shots.example.com",
            )
            .unwrap(),
        );
        let app = metadata_router(state);

        for path in [
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
        ] {
            let response = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert!(response.status().is_success());
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let metadata: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(metadata["resource"], "https://api.anarlog.so/mcp");
            assert_eq!(
                metadata["authorization_servers"][0],
                "https://shots.example.com/api/auth"
            );
            assert_eq!(
                metadata["scopes_supported"],
                serde_json::json!(SHOTS_SCOPES)
            );
        }
    }

    #[tokio::test]
    async fn shots_discovery_names_the_configured_issuer_and_read_only_scope() {
        let config = CloudApiConfig::new(
            anlg_cloud_db::Database::new("postgres://127.0.0.1:1/unavailable").unwrap(),
            "https://shots.example.com",
        )
        .unwrap()
        .with_shots_oauth("http://localhost:3039/mcp", "https://shots.example.com")
        .unwrap();
        let state = AppState::new(config);
        assert!(
            state
                .oauth()
                .challenge(None)
                .contains("founder-hub:meetings:read")
        );
        let app = metadata_router(state);
        let response = app
            .clone()
            .oneshot(
                Request::get("/.well-known/oauth-protected-resource/mcp")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let metadata: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(metadata["resource"], "http://localhost:3039/mcp");
        assert_eq!(
            metadata["authorization_servers"][0],
            "https://shots.example.com/api/auth"
        );
        assert_eq!(
            metadata["scopes_supported"],
            serde_json::json!(SHOTS_SCOPES)
        );
        assert_eq!(
            app.oneshot(
                Request::get("/.well-known/openai-apps-challenge")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
            axum::http::StatusCode::NOT_FOUND
        );
        for resource in [
            "http://remote.example/mcp",
            "https://user:pass@example.com/mcp",
            "https://example.com/mcp?x=1",
            "https://example.com/other",
        ] {
            assert!(OAuthResourceConfig::shots(resource, "https://shots.example.com").is_err());
        }
    }
}
