use std::collections::HashMap;
use std::time::Duration;

use anlg_supabase_auth::{Claims, SubscriptionStatus, server::Error};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone)]
pub struct ShotsAuth {
    client: reqwest::Client,
    origin: reqwest::Url,
    service_token: reqwest::header::HeaderValue,
    storage: Option<crate::ShotsStorage>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotsUser {
    pub id: String,
    pub email: String,
    pub name: String,
    pub image: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotsWorkspace {
    pub organization_id: String,
    pub workspace_id: Uuid,
    pub owner_user_id: Uuid,
    pub name: String,
    pub role: String,
    pub permissions: Vec<String>,
    pub features: HashMap<String, bool>,
    pub owner: ShotsMember,
    pub members: Vec<ShotsMember>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotsMember {
    pub email_verified: bool,
    pub created_at: DateTime<Utc>,
    pub user: ShotsUser,
    pub account_user_id: Uuid,
    pub role: String,
    #[serde(default)]
    pub permissions: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotsSession {
    pub email_verified: bool,
    pub revision: String,
    pub created_at: DateTime<Utc>,
    pub user: ShotsUser,
    pub account_user_id: Uuid,
    pub session_id: String,
    pub expires_at: DateTime<Utc>,
    pub workspaces: Vec<ShotsWorkspace>,
    #[serde(skip)]
    access_token: String,
}

impl ShotsSession {
    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    pub fn allows(&self, workspace_id: &str, permission: &str) -> bool {
        if workspace_id == self.account_user_id.to_string() {
            return true;
        }
        self.workspaces.iter().any(|workspace| {
            workspace.workspace_id.to_string() == workspace_id
                && workspace
                    .permissions
                    .iter()
                    .any(|value| value == "workspace:read")
                && workspace
                    .permissions
                    .iter()
                    .any(|value| value == permission)
        })
    }

    pub fn claims(&self) -> Claims {
        let paid = self.workspaces.iter().any(|workspace| {
            workspace.features.get("workspace:paid") == Some(&true)
                && workspace
                    .permissions
                    .iter()
                    .any(|permission| permission == "workspace:read")
        });
        Claims {
            sub: self.account_user_id.to_string(),
            email: Some(self.user.email.clone()),
            entitlements: if paid {
                vec!["hyprnote_pro".into()]
            } else {
                vec![]
            },
            subscription_status: paid.then_some(SubscriptionStatus::Active),
            trial_end: None,
            has_payment_method: None,
            referral_extension: None,
        }
    }
}

impl ShotsAuth {
    pub fn new(origin: &str, service_token: &str) -> Result<Self, String> {
        if service_token.len() < 32 {
            return Err("SHOTS_AUTH_SERVICE_TOKEN must contain at least 32 bytes".into());
        }
        let mut service_token = reqwest::header::HeaderValue::from_str(service_token)
            .map_err(|_| "SHOTS_AUTH_SERVICE_TOKEN is invalid")?;
        service_token.set_sensitive(true);
        let origin = reqwest::Url::parse(origin).map_err(|_| "SHOTS_AUTH_URL is invalid")?;
        let local = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(origin.scheme() == "https" || origin.scheme() == "http" && local)
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
        {
            return Err(
                "SHOTS_AUTH_URL must be an HTTPS origin (HTTP is allowed only on loopback)".into(),
            );
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "could not create Shots auth client")?;
        Ok(Self {
            client,
            origin,
            service_token,
            storage: None,
        })
    }

    pub fn with_storage(mut self, storage: crate::ShotsStorage) -> Self {
        self.storage = Some(storage);
        self
    }

    pub async fn authenticate(&self, token: &str) -> Result<crate::AuthContext, Error> {
        let session = self.session(token).await?;
        let token = self
            .storage
            .as_ref()
            .ok_or(Error::JwksFetchFailed)?
            .user_token(&session)
            .await?;
        Ok(crate::AuthContext {
            token,
            claims: session.claims(),
            shots: Some(session),
        })
    }

    pub fn origin(&self) -> &reqwest::Url {
        &self.origin
    }

    /// Forwards a gateway request to `/api/founder-hub/{path}` with the service credential.
    /// `headers` must not carry `authorization` or the service header.
    pub async fn forward(
        &self,
        token: &str,
        path: &str,
        query: Option<&str>,
        method: reqwest::Method,
        headers: reqwest::header::HeaderMap,
        body: Vec<u8>,
    ) -> Result<reqwest::Response, reqwest::Error> {
        let mut url = self
            .origin
            .join(&format!("/api/founder-hub/{path}"))
            .expect("validated Founder Hub path");
        url.set_query(query);
        self.client
            .request(method, url)
            .headers(headers)
            .header("x-shots-founder-hub-service", &self.service_token)
            .bearer_auth(token)
            .body(body)
            .send()
            .await
    }

    pub async fn logout(&self, token: &str) -> Result<(), Error> {
        let response = self
            .client
            .post(
                self.origin
                    .join("api/founder-hub/logout")
                    .expect("fixed path"),
            )
            .header("x-shots-founder-hub-service", &self.service_token)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| Error::JwksFetchFailed)?;
        if response.status().is_success() || response.status().as_u16() == 401 {
            Ok(())
        } else {
            Err(Error::JwksFetchFailed)
        }
    }

    pub async fn session(&self, token: &str) -> Result<ShotsSession, Error> {
        let response = self
            .client
            .get(
                self.origin
                    .join("api/founder-hub/session")
                    .expect("fixed path"),
            )
            .bearer_auth(token)
            .header("x-shots-founder-hub-service", &self.service_token)
            .send()
            .await
            .map_err(|_| Error::JwksFetchFailed)?;
        Self::read_session(response, token).await
    }

    pub async fn key_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<crate::AuthContext, Error> {
        let response = self
            .client
            .post(
                self.origin
                    .join("api/founder-hub/key-session")
                    .expect("fixed path"),
            )
            .header("x-shots-founder-hub-service", &self.service_token)
            .json(&serde_json::json!({ "userId": user_id, "sessionId": session_id }))
            .send()
            .await
            .map_err(|_| Error::JwksFetchFailed)?;
        let session = Self::read_session(response, "").await?;
        if session.user.id != user_id || session.session_id != session_id {
            return Err(Error::InvalidToken);
        }
        self.connector_context(session).await
    }

    pub async fn connector_session(&self, token: &str) -> Result<crate::AuthContext, Error> {
        let response = self
            .client
            .get(
                self.origin
                    .join("api/founder-hub/connector-session")
                    .expect("fixed path"),
            )
            .header("x-shots-founder-hub-service", &self.service_token)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| Error::JwksFetchFailed)?;
        self.connector_context(Self::read_session(response, "").await?)
            .await
    }

    async fn connector_context(&self, session: ShotsSession) -> Result<crate::AuthContext, Error> {
        self.storage
            .as_ref()
            .ok_or(Error::JwksFetchFailed)?
            .project(&session)
            .await?;
        Ok(crate::AuthContext {
            claims: session.claims(),
            token: String::new(),
            shots: Some(session),
        })
    }

    async fn read_session(response: reqwest::Response, token: &str) -> Result<ShotsSession, Error> {
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(Error::InvalidToken);
        }
        if !response.status().is_success() {
            return Err(Error::JwksFetchFailed);
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::JwksFetchFailed)? {
            if body.len() + chunk.len() > 1024 * 1024 {
                return Err(Error::JwksFetchFailed);
            }
            body.extend_from_slice(&chunk);
        }
        let mut session: ShotsSession =
            serde_json::from_slice(&body).map_err(|_| Error::JwksFetchFailed)?;
        if session.account_user_id.is_nil()
            || session.user.id.is_empty()
            || session.session_id.is_empty()
            || session.expires_at <= Utc::now()
            || session.revision.parse::<u64>().is_err()
            || session.workspaces.iter().any(|workspace| {
                workspace.workspace_id.is_nil()
                    || workspace.owner_user_id != workspace.owner.account_user_id
            })
        {
            return Err(Error::InvalidToken);
        }
        session.access_token = token.to_owned();
        Ok(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{header, method, path},
    };

    #[tokio::test]
    async fn shots_rechecks_authority_and_maps_identity_without_trusting_token_claims() {
        let server = MockServer::start().await;
        let auth = crate::AuthState::new(&server.uri()).with_shots(Some(
            ShotsAuth::new(&server.uri(), "test-shots-service-token-thirty-two-bytes").unwrap(),
        ));
        let owner = serde_json::json!({
            "emailVerified": true,
            "createdAt": "2026-01-01T00:00:00Z",
            "user": {"id": "shots-user", "email": "person@example.test", "name": "Person", "image": null},
            "accountUserId": "dd26c713-2b48-4a8a-b3aa-91af23298eed",
            "role": "owner", "permissions": ["workspace:read", "artifact:edit"]
        });
        let body = serde_json::json!({
            "emailVerified": true,
            "revision": "1",
            "createdAt": "2026-01-01T00:00:00Z",
            "user": {"id": "shots-user", "email": "person@example.test", "name": "Person", "image": null},
            "accountUserId": "dd26c713-2b48-4a8a-b3aa-91af23298eed",
            "sessionId": "live-session",
            "expiresAt": (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            "workspaces": [{
                "organizationId": "shots-team",
                "workspaceId": "db2ddcf4-8e8e-45a7-b5b2-97b5fa0a0737",
                "ownerUserId": "dd26c713-2b48-4a8a-b3aa-91af23298eed",
                "owner": owner, "members": [owner],
                "name": "Team", "role": "owner", "permissions": ["workspace:read"],
                "features": {"workspace:paid": true}
            }]
        });
        Mock::given(method("GET"))
            .and(path("/api/founder-hub/session"))
            .and(header("authorization", "Bearer native-token"))
            .and(header(
                "x-shots-founder-hub-service",
                "test-shots-service-token-thirty-two-bytes",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(body.clone()))
            .mount(&server)
            .await;
        let claims = auth.verify_token("native-token").await.ok().unwrap();
        assert_eq!(claims.sub, "dd26c713-2b48-4a8a-b3aa-91af23298eed");
        assert!(claims.is_pro());
        Mock::given(method("POST"))
            .and(path("/rest/v1/rpc/project_shots_authority"))
            .and(header("authorization", "Bearer internal-service"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let secret = "test-signing-key-at-least-thirty-two-bytes";
        let storage = crate::ShotsStorage::new(&server.uri(), "internal-service", secret).unwrap();
        let central = ShotsAuth::new(&server.uri(), "test-shots-service-token-thirty-two-bytes")
            .unwrap()
            .with_storage(storage);
        let context = central.authenticate("native-token").await.ok().unwrap();
        assert_ne!(context.token, "native-token");
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
        validation.set_audience(&["authenticated"]);
        let internal = jsonwebtoken::decode::<serde_json::Value>(
            &context.token,
            &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
            &validation,
        )
        .unwrap()
        .claims;
        assert_eq!(internal["sub"], context.claims.sub);
        assert_eq!(internal["shots_revision"], "1");
        assert_eq!(internal["role"], "shots_hub_authenticated");
        assert!(internal["exp"].as_i64().unwrap() <= Utc::now().timestamp() + 60);
        assert!(!internal.to_string().contains("native-token"));
        let session = context.shots.unwrap();
        assert_eq!(session.access_token(), "native-token");
        assert!(!session.allows("db2ddcf4-8e8e-45a7-b5b2-97b5fa0a0737", "artifact:edit"));
        assert!(session.allows("db2ddcf4-8e8e-45a7-b5b2-97b5fa0a0737", "workspace:read"));
        server.reset().await;
        Mock::given(method("GET"))
            .and(path("/api/founder-hub/session"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/rpc/project_shots_authority"))
            .respond_with(ResponseTemplate::new(409))
            .mount(&server)
            .await;
        assert!(central.authenticate("native-token").await.is_err());
        server.reset().await;
        Mock::given(method("GET"))
            .and(path("/api/founder-hub/session"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        assert!(auth.verify_token("native-token").await.is_err());
        server.reset().await;
        Mock::given(method("GET"))
            .and(path("/api/founder-hub/session"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        assert!(auth.verify_token("native-token").await.is_err());
        assert!(
            auth.verify_oauth_token("native-token", "other-resource", &["meetings:read"])
                .await
                .is_err()
        );
    }

    #[test]
    fn shots_credentials_are_only_sent_to_a_configured_secure_origin() {
        assert!(ShotsAuth::new("https://shots.example.com", "short").is_err());
        for origin in [
            "http://example.com",
            "https://user:password@example.com",
            "https://example.com/path",
            "https://example.com?other=1",
        ] {
            assert!(ShotsAuth::new(origin, "test-shots-service-token-thirty-two-bytes").is_err());
        }
        assert!(
            ShotsAuth::new(
                "https://shots.example.com",
                "test-shots-service-token-thirty-two-bytes"
            )
            .is_ok()
        );
        assert!(
            ShotsAuth::new(
                "http://127.0.0.1:3009",
                "test-shots-service-token-thirty-two-bytes"
            )
            .is_ok()
        );
    }
}
