use std::time::Duration;

use anlg_supabase_auth::server::Error;
use chrono::Utc;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::json;

use crate::ShotsSession;

#[derive(Clone)]
pub struct ShotsStorage {
    client: reqwest::Client,
    origin: reqwest::Url,
    service_key: String,
    signing_key: EncodingKey,
}

impl ShotsStorage {
    pub fn new(origin: &str, service_key: &str, signing_secret: &str) -> Result<Self, String> {
        let origin = reqwest::Url::parse(origin).map_err(|_| "invalid storage origin")?;
        if !matches!(origin.scheme(), "http" | "https")
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
            || signing_secret.len() < 32
            || service_key.is_empty()
        {
            return Err("Shots storage requires an origin, service credential, and SUPABASE_JWT_SECRET of at least 32 bytes".into());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "storage HTTP client unavailable")?;
        Ok(Self {
            client,
            origin,
            service_key: service_key.to_owned(),
            signing_key: EncodingKey::from_secret(signing_secret.as_bytes()),
        })
    }

    pub async fn project(&self, session: &ShotsSession) -> Result<(), Error> {
        let response = self
            .client
            .post(
                self.origin
                    .join("rest/v1/rpc/project_shots_authority")
                    .expect("fixed path"),
            )
            .header("apikey", &self.service_key)
            .bearer_auth(&self.service_key)
            .json(&json!({ "p_snapshot": session }))
            .send()
            .await
            .map_err(|_| Error::JwksFetchFailed)?;
        if !response.status().is_success() {
            return Err(Error::JwksFetchFailed);
        }
        Ok(())
    }

    pub async fn user_token(&self, session: &ShotsSession) -> Result<String, Error> {
        self.project(session).await?;
        let now = Utc::now().timestamp();
        let expires = (now + 60).min(session.expires_at.timestamp());
        if expires <= now {
            return Err(Error::InvalidToken);
        }
        jsonwebtoken::encode(
            &Header::new(Algorithm::HS256),
            &json!({
                "iss": self.origin.join("auth/v1").expect("fixed path").as_str(),
                "aud": "authenticated", "role": "shots_hub_authenticated", "sub": session.account_user_id,
                "iat": now, "exp": expires, "email": session.user.email,
                "shots_revision": session.revision, "shots_session_id": session.session_id,
                "app_metadata": { "provider": "shots" },
                "entitlements": session.claims().entitlements,
            }),
            &self.signing_key,
        )
        .map_err(|_| Error::JwksFetchFailed)
    }
}
