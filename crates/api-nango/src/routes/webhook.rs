use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use anlg_nango::{AuthOperation, NangoAuthWebhook, WebhookType};

use crate::error::{NangoError, Result};
use crate::state::AppState;

pub type ForwardHandler =
    Arc<dyn Fn(serde_json::Value) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

pub type ForwardHandlerRegistry = HashMap<String, ForwardHandler>;

pub fn forward_handler<F, Fut>(f: F) -> ForwardHandler
where
    F: Fn(serde_json::Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    Arc::new(move |payload| Box::pin(f(payload)))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WebhookResponse {
    pub status: String,
}

#[derive(Debug, Deserialize)]
struct WebhookTypeEnvelope {
    #[serde(rename = "type")]
    webhook_type: WebhookType,
}

#[utoipa::path(
    post,
    path = "/webhook",
    responses(
        (status = 200, description = "Webhook processed", body = WebhookResponse),
        (status = 401, description = "Invalid signature"),
        (status = 400, description = "Bad request"),
    ),
    tag = "nango",
)]
pub async fn nango_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> Result<Json<WebhookResponse>> {
    let signature = headers
        .get("x-nango-hmac-sha256")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| NangoError::Auth("Missing X-Nango-Hmac-Sha256 header".to_string()))?;

    let valid = anlg_nango::verify_webhook_signature(
        &state.config.nango.nango_webhook_signing_key,
        body.as_bytes(),
        signature,
    );
    if !valid {
        return Err(NangoError::Auth("Invalid webhook signature".to_string()));
    }

    let envelope: WebhookTypeEnvelope =
        serde_json::from_str(&body).map_err(|e| NangoError::BadRequest(e.to_string()))?;

    match envelope.webhook_type {
        WebhookType::Forward => handle_forward_webhook(&state, &body)?,
        WebhookType::Auth => {
            let payload: NangoAuthWebhook =
                serde_json::from_str(&body).map_err(|e| NangoError::BadRequest(e.to_string()))?;
            handle_auth_webhook(&state, payload).await?;
        }
        other => {
            tracing::info!(webhook_type = ?other, "nango webhook received (ignored)");
        }
    }

    Ok(Json(WebhookResponse {
        status: "ok".to_string(),
    }))
}

fn handle_forward_webhook(state: &AppState, body: &str) -> Result<()> {
    let forward: anlg_nango::NangoForwardWebhook =
        serde_json::from_str(body).map_err(|e| NangoError::BadRequest(e.to_string()))?;

    tracing::info!(
        provider = %forward.provider,
        connection_id = %forward.connection_id,
        "nango forward webhook received"
    );

    if let Some(handler) = state
        .forward_handlers
        .get(forward.provider_config_key.as_str())
    {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler(forward.payload).await;
        });
    } else {
        tracing::info!(
            provider_config_key = %forward.provider_config_key,
            "unhandled forward webhook provider"
        );
    }

    Ok(())
}

pub(crate) async fn handle_auth_webhook(state: &AppState, payload: NangoAuthWebhook) -> Result<()> {
    tracing::info!(
        webhook_type = ?payload.r#type,
        operation = ?payload.operation,
        "nango webhook received"
    );

    if payload.operation == AuthOperation::Refresh && !payload.success {
        state
            .store
            .mark_connection_refresh_failed(
                &payload.provider_config_key,
                &payload.connection_id,
                Some("provider_auth"),
                None,
            )
            .await
            .map_err(|_| {
                tracing::error!("failed_to_persist_nango_refresh_failure_state");
                NangoError::Internal("failed to persist refresh state".to_string())
            })?;

        return Ok(());
    }

    if payload.success && payload.operation == AuthOperation::Deletion {
        state
            .store
            .delete_connection_by_connection(&payload.provider_config_key, &payload.connection_id)
            .await
            .map_err(|_| {
                tracing::error!("failed_to_delete_nango_connection");
                NangoError::Internal("failed to delete connection".to_string())
            })?;

        tracing::info!("nango connection deleted locally from webhook");

        return Ok(());
    }

    if payload.success && payload.operation != AuthOperation::Deletion {
        let Some(end_user_id) = payload.end_user_id() else {
            tracing::warn!("nango auth webhook missing end user id, skipping persistence");
            return Ok(());
        };

        state
            .store
            .upsert_connection(
                end_user_id,
                &payload.provider_config_key,
                &payload.connection_id,
                &payload.provider,
            )
            .await
            .map_err(|_| {
                tracing::error!("failed_to_upsert_nango_connection");
                NangoError::Internal("failed to store connection".to_string())
            })?;

        tracing::info!(
            anarlog.auth.operation = ?payload.operation,
            "nango connection upserted"
        );

        if matches!(
            payload.operation,
            AuthOperation::Creation | AuthOperation::Override
        ) {
            super::identity::spawn_identity_task(
                state.nango.clone(),
                payload.provider_config_key.clone(),
                payload.connection_id.clone(),
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{body_json, method, path, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use anlg_nango::{
        AuthOperation, NangoAuthWebhook, NangoWebhookEndUser, NangoWebhookError, WebhookType,
    };

    use crate::config::NangoConfig;
    use crate::error::NangoError;
    use crate::state::AppState;

    use axum::extract::State;
    use axum::http::{HeaderMap, HeaderValue};

    use super::{handle_auth_webhook, handle_forward_webhook, nango_webhook};

    const API_KEY: &str = "test-api-key";
    const WEBHOOK_SIGNING_KEY: &str = "test-webhook-signing-key";

    fn sign_body_with(secret: &str, body: &str) -> String {
        use hmac::{Hmac, KeyInit, Mac};
        use sha2::Sha256;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn sign_body(body: &str) -> String {
        sign_body_with(WEBHOOK_SIGNING_KEY, body)
    }

    fn signature_headers(signature: String) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-nango-hmac-sha256",
            HeaderValue::from_str(&signature).unwrap(),
        );
        headers
    }

    async fn make_fixture() -> (MockServer, AppState) {
        let nango_mock = MockServer::start().await;
        let config = NangoConfig::for_test(&nango_mock.uri());
        let state = AppState::new(config);
        (nango_mock, state)
    }

    fn auth_payload(operation: AuthOperation, success: bool) -> NangoAuthWebhook {
        NangoAuthWebhook {
            r#type: WebhookType::Auth,
            operation,
            connection_id: "conn-123".to_string(),
            auth_mode: "OAUTH2".to_string(),
            provider_config_key: "google-calendar".to_string(),
            provider: "google-calendar".to_string(),
            environment: "DEV".to_string(),
            success,
            tags: None,
            end_user: Some(NangoWebhookEndUser {
                end_user_id: "11111111-1111-4111-8111-111111111111".to_string(),
                end_user_email: None,
                tags: None,
            }),
            error: None,
        }
    }

    // --- Signature validation ---

    #[tokio::test]
    async fn webhook_signature_uses_webhook_signing_key_not_api_key() {
        let (_nango_mock, state) = make_fixture().await;
        let body = r#"{"type":"sync"}"#.to_string();

        let signed_with_api_key = nango_webhook(
            State(state.clone()),
            signature_headers(sign_body_with(API_KEY, &body)),
            body.clone(),
        )
        .await;
        assert!(matches!(signed_with_api_key, Err(NangoError::Auth(_))));

        let signed_with_webhook_key =
            nango_webhook(State(state), signature_headers(sign_body(&body)), body).await;
        assert!(signed_with_webhook_key.is_ok());
    }

    // --- handle_auth_webhook ---

    #[tokio::test]
    async fn creation_upserts_connection_and_patches_identity() {
        let (nango_mock, state) = make_fixture().await;

        let user = crate::config::test_user(&state.config.database).await;
        let connection_id = format!("conn-{user}");
        Mock::given(method("GET"))
            .and(path("/proxy/calendar/v3/calendars/primary"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"id": "user@example.com", "summary": "Test User"}),
            ))
            .mount(&nango_mock)
            .await;

        Mock::given(method("GET"))
            .and(path(format!("/connections/{connection_id}")))
            .and(query_param("provider_config_key", "google-calendar"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 1,
                "connection_id": connection_id,
                "provider_config_key": "google-calendar",
                "provider": "google-calendar",
                "errors": [],
                "end_user": null,
                "tags": {
                    "end_user_id": "11111111-1111-4111-8111-111111111111",
                    "end_user_email": "user@old.example.com"
                },
                "metadata": {},
                "connection_config": {},
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
                "last_fetched_at": "2026-01-01T00:00:00Z",
                "credentials": {}
            })))
            .expect(1)
            .mount(&nango_mock)
            .await;

        Mock::given(method("PATCH"))
            .and(path_regex(format!("/connections/{connection_id}")))
            .and(query_param("provider_config_key", "google-calendar"))
            .and(body_json(serde_json::json!({
                "tags": {
                    "end_user_id": "11111111-1111-4111-8111-111111111111",
                    "end_user_email": "user@old.example.com",
                    "account_identity": "user@example.com"
                }
            })))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&nango_mock)
            .await;

        handle_auth_webhook(&state, {
            let mut payload = auth_payload(AuthOperation::Creation, true);
            payload.connection_id = connection_id.clone();
            payload.end_user.as_mut().unwrap().end_user_id = user.to_string();
            payload
        })
        .await
        .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
        let row = anlg_cloud_db::entities::nango_connection::Entity::find()
            .filter(
                anlg_cloud_db::entities::nango_connection::Column::ConnectionId.eq(&connection_id),
            )
            .one(state.config.database.connection().await.unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.user_id, user);
        assert_eq!(row.status, "connected");
        nango_mock.verify().await;
    }

    #[tokio::test]
    async fn refresh_failure_and_deletion_update_the_database() {
        use anlg_cloud_db::entities::nango_connection as connection;
        use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
        let (_nango, state) = make_fixture().await;
        let user = crate::config::test_user(&state.config.database).await;
        let id = format!("conn-{user}");
        state
            .store
            .upsert_connection(&user.to_string(), "google-calendar", &id, "google-calendar")
            .await
            .unwrap();
        let mut payload = auth_payload(AuthOperation::Refresh, false);
        payload.connection_id = id.clone();
        payload.error = Some(NangoWebhookError {
            r#type: "refresh_token_error".into(),
            description: "Token expired".into(),
        });
        handle_auth_webhook(&state, payload).await.unwrap();
        let query = connection::Entity::find().filter(connection::Column::ConnectionId.eq(&id));
        let row = query
            .clone()
            .one(state.config.database.connection().await.unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "reconnect_required");
        assert_eq!(row.last_error_type.as_deref(), Some("provider_auth"));
        let mut payload = auth_payload(AuthOperation::Deletion, true);
        payload.connection_id = id;
        handle_auth_webhook(&state, payload).await.unwrap();
        assert!(
            query
                .one(state.config.database.connection().await.unwrap())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn missing_end_user_id_skips_persistence() {
        let (_nango_mock, state) = make_fixture().await;

        let mut payload = auth_payload(AuthOperation::Creation, true);
        payload.end_user = None;

        let result = handle_auth_webhook(&state, payload).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn malformed_forward_webhook_returns_bad_request() {
        let (_nango_mock, state) = make_fixture().await;

        let result = handle_forward_webhook(&state, r#"{"type":"forward"}"#);

        assert!(matches!(result, Err(NangoError::BadRequest(_))));
    }
}
