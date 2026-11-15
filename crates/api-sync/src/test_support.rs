use anlg_api_auth::{AuthContext, ShotsSession};
use anlg_cloud_db::{Database, Principal};
use anlg_r2_storage::{Config, Storage};
use axum::{
    Extension, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

pub fn database() -> Database {
    Database::new(
        &std::env::var("CLOUD_DATABASE_TEST_URL")
            .unwrap_or_else(|_| "postgres://localhost/unavailable_test_database".into()),
    )
    .unwrap()
}
pub fn storage() -> Storage {
    let config: Config =
        serde_json::from_str(&std::env::var("R2_TEST_CONFIG").unwrap_or_else(|_| {
            json!({
                "r2_endpoint":"http://127.0.0.1:9000", "r2_bucket":"founder-hub-test",
                "r2_access_key_id":"test-access-key", "r2_secret_access_key":"test-secret-key"
            })
            .to_string()
        }))
        .unwrap();
    Storage::new(&config).unwrap()
}
pub fn state() -> crate::AppState {
    crate::AppState::new(crate::SyncConfig {
        issuer: None,
        legacy_database_id: None,
        protocol_mode: crate::config::CloudsyncProtocolMode::E2eeEnforced,
        desktop_transport: crate::config::CloudsyncTransport::Replica,
        token_ttl_seconds: 60,
        database: database(),
        storage: storage(),
        signing_key: "test-signing-key-at-least-thirty-two-bytes".into(),
    })
}
pub async fn account(db: &Database) -> AuthContext {
    let id = Uuid::new_v4();
    let workspace = Uuid::new_v4();
    let user = json!({"id":id.to_string(), "email":format!("{id}@example.test"), "name":"Integration", "image":null});
    let permissions = json!([
        "workspace:read",
        "artifact:read",
        "artifact:edit",
        "artifact:create",
        "artifact:share",
        "workspace:manage",
        "member:read",
        "identity:manage"
    ]);
    let member = json!({"emailVerified":true,"createdAt":chrono::Utc::now(),"user":user,"accountUserId":id,"role":"owner","permissions":permissions});
    let snapshot = json!({
        "emailVerified":true,"revision":"1","createdAt":chrono::Utc::now(),"user":user,
        "accountUserId":id,"sessionId":Uuid::new_v4().to_string(),
        "expiresAt":chrono::Utc::now()+chrono::Duration::hours(1),
        "workspaces":[{"organizationId":workspace.to_string(),"workspaceId":workspace,"ownerUserId":id,
            "owner":member,"members":[member],"name":"Team","role":"owner","permissions":permissions,"features":{"workspace:paid":true}}]
    });
    db.rpc::<Value>(
        &Principal::Service,
        "project_shots_authority",
        &json!({"p_snapshot":snapshot}),
    )
    .await
    .unwrap();
    db.rpc::<Value>(
        &Principal::Service,
        "claim_personal_workspace_e2ee_key",
        &json!({"p_actor_user_id":id,"p_key_id":"abcdefghijklmnopqrstuv"}),
    )
    .await
    .unwrap();
    let shots: ShotsSession = serde_json::from_value(snapshot).unwrap();
    AuthContext {
        claims: shots.claims(),
        shots: Some(shots),
        token: "opaque-test-token".into(),
    }
}
pub fn router(state: crate::AppState, auth: AuthContext) -> Router {
    crate::cloudsync_router(state.clone())
        .merge(crate::replica_router(state.replica.clone()))
        .merge(crate::device_router(state.replica.clone()))
        .merge(crate::e2ee_witness_router(state.replica.clone()))
        .merge(crate::session_share_router(state.clone()))
        .merge(crate::web_edit_router(state.clone()))
        .merge(crate::file_router(state.clone()))
        .merge(crate::file_upload_router(state))
        .layer(Extension(auth))
}
pub async fn request(
    router: &Router,
    method: &str,
    path: &str,
    body: Value,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("x-upload-token", token);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 32 * 1024 * 1024)
        .await
        .unwrap();
    let body =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, body)
}
pub async fn ok(
    router: &Router,
    method: &str,
    path: &str,
    body: Value,
    token: Option<&str>,
) -> Value {
    let (status, body) = request(router, method, path, body, token).await;
    assert!(status.is_success(), "{path}: {status}: {body}");
    body
}
