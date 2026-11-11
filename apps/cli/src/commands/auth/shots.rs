use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anlg_supabase_auth::{refresh::AuthClient, session::Session};
use axum::{Router, extract::RawQuery, http::StatusCode, response::IntoResponse, routing::get};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, oneshot};
use url::Url;
use uuid::Uuid;

use super::{AuthStore, decode_token_claims};
use crate::{Error, Result};

pub(super) struct Shots {
    origin: Url,
    pub(super) api: Url,
}

impl Shots {
    pub(super) fn from_env() -> Result<Option<Self>> {
        let origin = std::env::var("ANARLOG_SHOTS_URL")
            .ok()
            .or_else(|| option_env!("VITE_SHOTS_URL").map(str::to_string));
        let Some(origin) = origin.filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let api = std::env::var("ANARLOG_API_URL")
            .ok()
            .or_else(|| option_env!("VITE_API_URL").map(str::to_string))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::operation(
                    "configure Shots",
                    "ANARLOG_API_URL is required with ANARLOG_SHOTS_URL",
                )
            })?;
        let origin = secure_url(&origin)?;
        if origin.path() != "/" {
            return Err(Error::operation(
                "configure Shots",
                "ANARLOG_SHOTS_URL must be an origin",
            ));
        }
        Ok(Some(Self {
            origin,
            api: secure_url(&api)?,
        }))
    }

    fn gateway(&self) -> String {
        format!("{}/cloud", self.api.as_str().trim_end_matches('/'))
    }

    pub(super) fn storage_key(&self) -> String {
        format!(
            "sb-{}-auth-token",
            self.api
                .host_str()
                .expect("validated host")
                .split('.')
                .next()
                .expect("host label")
        )
    }

    fn issuer(&self) -> String {
        self.origin
            .join("api/auth")
            .expect("fixed path")
            .to_string()
    }

    fn validate_session(&self, session: &Session) -> Result<()> {
        let claims = decode_token_claims(&session.access_token)?;
        let user = session.user.as_ref().ok_or_else(|| {
            Error::operation("verify Shots session", "account identity is missing")
        })?;
        if claims.iss != self.issuer()
            || claims.account_user_id.as_deref() != Some(&user.id)
            || Uuid::parse_str(&user.id).is_err()
        {
            return Err(Error::operation(
                "verify Shots session",
                "session does not match the Shots account authority",
            ));
        }
        Ok(())
    }

    pub(super) async fn current_session(&self, store: &AuthStore) -> Result<Option<Session>> {
        let mut data = store.load()?.data;
        let key = self.storage_key();
        let Some(encoded) = data.get(&key) else {
            return Ok(None);
        };
        let session: Session = serde_json::from_str(encoded)
            .map_err(|_| Error::operation("read Shots session", "stored session is invalid"))?;
        if session
            .extra
            .get("shots_gateway_url")
            .and_then(|value| value.as_str())
            != Some(self.gateway().as_str())
        {
            return Err(Error::operation(
                "read Shots session",
                "the stored session belongs to another gateway; sign in again",
            ));
        }
        self.validate_session(&session)?;
        if !session.requires_refresh(SystemTime::now(), Duration::from_secs(60)) {
            return Ok(Some(session));
        }
        let client = AuthClient::new(self.gateway(), "shots-founder-hub");
        let mut refreshed = match client
            .refresh_session(session.refresh_token().unwrap_or(""))
            .await
        {
            Ok(value) => value,
            Err(error) if error.is_fatal() => {
                store.remove_sessions()?;
                return Ok(None);
            }
            Err(_) => {
                return Err(Error::operation(
                    "refresh Shots session",
                    "Shots is unavailable; try again",
                ));
            }
        };
        self.validate_session(&refreshed)?;
        if refreshed.user.as_ref().map(|user| &user.id)
            != session.user.as_ref().map(|user| &user.id)
        {
            return Err(Error::operation(
                "refresh Shots session",
                "account changed during refresh",
            ));
        }
        refreshed
            .extra
            .insert("shots_gateway_url".into(), self.gateway().into());
        data.insert(
            key,
            serde_json::to_string(&refreshed)
                .map_err(|_| Error::operation("save Shots session", "could not encode session"))?,
        );
        store.save(&data)?;
        Ok(Some(refreshed))
    }

    pub(super) async fn login(&self) -> Result<Session> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| Error::operation("start Shots sign-in", error.to_string()))?;
        let redirect = format!(
            "http://127.0.0.1:{}/auth/callback",
            listener
                .local_addr()
                .map_err(|error| Error::operation("start Shots sign-in", error.to_string()))?
                .port()
        );
        let state = Uuid::new_v4().to_string();
        // Three UUIDs provide more than 256 random bits without another randomness dependency.
        let verifier = format!(
            "{}{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut authorize = self
            .origin
            .join("api/auth/oauth2/authorize")
            .expect("fixed path");
        authorize
            .query_pairs_mut()
            .append_pair("client_id", "shots-founder-hub")
            .append_pair("response_type", "code")
            .append_pair("prompt", "login")
            .append_pair("scope", "openid profile email offline_access founder-hub")
            .append_pair("redirect_uri", &redirect)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        let (send, receive) = oneshot::channel();
        let sender = Arc::new(Mutex::new(Some(send)));
        let issuer = self.issuer();
        let router = Router::new().route("/auth/callback", get(move |RawQuery(query): RawQuery| {
            let sender = sender.clone();
            let state = state.clone();
            let issuer = issuer.clone();
            async move {
                let Some(code) = callback_code(query.as_deref().unwrap_or(""), &state, &issuer) else {
                    return (StatusCode::BAD_REQUEST, "Invalid sign-in callback. Return to the original sign-in tab.").into_response();
                };
                let Some(send) = sender.lock().await.take() else {
                    return (StatusCode::CONFLICT, "This sign-in callback has already been received.").into_response();
                };
                let _ = send.send(code);
                (StatusCode::OK, [("cache-control", "no-store"), ("referrer-policy", "no-referrer"), ("content-type", "text/html; charset=utf-8")], "<!doctype html><title>Shots sign-in</title><p>Sign-in received. Return to the terminal to finish.</p><script>history.replaceState(null, '', '/auth/callback')</script>").into_response()
            }
        }));
        let (stop, stopped) = oneshot::channel();
        let mut server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        eprintln!(
            "Open this URL to sign in through Shots:\n{authorize}\n\nWaiting for your browser (10 minutes)…"
        );
        let code = tokio::time::timeout(Duration::from_secs(600), receive).await;
        let _ = stop.send(());
        if tokio::time::timeout(Duration::from_secs(2), &mut server)
            .await
            .is_err()
        {
            server.abort();
        }
        let code = code
            .map_err(|_| Error::operation("Shots sign-in", "sign-in timed out; start again"))?
            .map_err(|_| Error::operation("Shots sign-in", "callback listener stopped"))?;
        let response = client()?.post(format!("{}/auth/v1/token?grant_type=authorization_code", self.gateway()))
            .json(&serde_json::json!({ "code": code, "code_verifier": verifier, "redirect_uri": redirect }))
            .send().await.map_err(|_| Error::operation("Shots sign-in", "could not contact the Founder Hub gateway"))?;
        if !response.status().is_success() {
            return Err(Error::operation(
                "Shots sign-in",
                "the sign-in code was rejected; start again",
            ));
        }
        let mut session: Session = response
            .json()
            .await
            .map_err(|_| Error::operation("Shots sign-in", "invalid session response"))?;
        self.validate_session(&session)?;
        session
            .extra
            .insert("shots_gateway_url".into(), self.gateway().into());
        Ok(session)
    }

    pub(super) async fn logout(&self, session: &Session) -> Result<()> {
        let response = client()?
            .post(format!("{}/auth/v1/logout?scope=local", self.gateway()))
            .bearer_auth(&session.access_token)
            .send()
            .await
            .map_err(|_| Error::operation("Shots sign-out", "could not reach Shots; try again"))?;
        if response.status().is_success() || response.status() == StatusCode::UNAUTHORIZED {
            return Ok(());
        }
        Err(Error::operation(
            "Shots sign-out",
            "Shots could not revoke the session; try again",
        ))
    }
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::operation("connect to Shots", "could not create HTTP client"))
}

fn secure_url(value: &str) -> Result<Url> {
    let url = Url::parse(value)
        .map_err(|_| Error::operation("configure Shots", "invalid service URL"))?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.scheme() != "https"
            && !(url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
    {
        return Err(Error::operation(
            "configure Shots",
            "service URLs require HTTPS or loopback HTTP without credentials, query, or fragment",
        ));
    }
    Ok(url)
}

fn callback_code(query: &str, expected_state: &str, expected_issuer: &str) -> Option<String> {
    if query.len() > 8192 {
        return None;
    }
    let pairs = url::form_urlencoded::parse(query.as_bytes()).collect::<Vec<_>>();
    let single = |name: &str| {
        let mut values = pairs
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_ref());
        let value = values.next()?;
        (!value.is_empty() && values.next().is_none()).then_some(value)
    };
    if single("state")? != expected_state
        || single("iss")? != expected_issuer
        || pairs
            .iter()
            .any(|(key, _)| matches!(key.as_ref(), "access_token" | "refresh_token"))
    {
        return None;
    }
    single("code").map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, header, method, path, query_param},
    };

    #[test]
    fn callbacks_bind_state_issuer_and_one_code_without_accepting_injected_tokens() {
        let query = "code=once&state=pending&iss=https%3A%2F%2Fshots.example%2Fapi%2Fauth";
        assert_eq!(
            callback_code(query, "pending", "https://shots.example/api/auth").as_deref(),
            Some("once")
        );
        for invalid in [
            query.replace("pending", "other"),
            query.replace("shots.example", "attacker.example"),
            format!("{query}&code=twice"),
            format!("{query}&access_token=injected"),
            format!("{query}&state=pending"),
        ] {
            assert!(callback_code(&invalid, "pending", "https://shots.example/api/auth").is_none());
        }
        for invalid in [
            "http://example.com",
            "https://user:password@example.com",
            "https://example.com?token=secret",
            "https://example.com#fragment",
        ] {
            assert!(secure_url(invalid).is_err());
        }
    }

    #[tokio::test]
    async fn refresh_keeps_the_mapped_account_and_revokes_the_live_session_on_logout() {
        let server = MockServer::start().await;
        let shots = Shots {
            origin: Url::parse("https://shots.example").unwrap(),
            api: Url::parse(&server.uri()).unwrap(),
        };
        let user_id = Uuid::new_v4().to_string();
        let make_session = |expiry| {
            let token = format!("header.{}.signature", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({ "sub": "opaque-shots-person", "account_user_id": user_id, "iss": shots.issuer(), "exp": expiry })).unwrap()));
            serde_json::from_value::<Session>(json!({ "access_token": token, "refresh_token": "refresh", "expires_in": 300, "expires_at": expiry, "user": { "id": user_id, "email": "test@example.com" }, "shots_gateway_url": shots.gateway() })).unwrap()
        };
        let directory = tempfile::tempdir().unwrap();
        let store = AuthStore::at(directory.path().join("auth.shots-cli.json"));
        store
            .save(&HashMap::from([
                (
                    shots.storage_key(),
                    serde_json::to_string(&make_session(1)).unwrap(),
                ),
                ("unrelated".into(), "keep".into()),
            ]))
            .unwrap();
        let next = make_session(super::super::unix_timestamp() + 300);
        Mock::given(method("POST"))
            .and(path("/cloud/auth/v1/token"))
            .and(query_param("grant_type", "refresh_token"))
            .and(body_json(json!({"refresh_token":"refresh"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(&next))
            .mount(&server)
            .await;
        let current = shots.current_session(&store).await.unwrap().unwrap();
        assert_eq!(current.user.as_ref().unwrap().id, user_id);
        assert_ne!(current.user.as_ref().unwrap().id, "opaque-shots-person");
        let persisted = store.load().unwrap();
        assert_eq!(persisted.data["unrelated"], "keep");
        assert_eq!(
            serde_json::from_str::<Session>(&persisted.data[&shots.storage_key()]).unwrap(),
            current
        );
        Mock::given(method("POST"))
            .and(path("/cloud/auth/v1/logout"))
            .and(header(
                "authorization",
                format!("Bearer {}", current.access_token),
            ))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        shots.logout(&current).await.unwrap();
        let other = Shots {
            origin: Url::parse("https://other.example").unwrap(),
            api: shots.api.clone(),
        };
        assert!(other.current_session(&store).await.is_err());
    }
}
