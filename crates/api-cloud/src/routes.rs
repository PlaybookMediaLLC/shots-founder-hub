use anlg_agent_access as access;
use anlg_api_auth::AuthContext;
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, put},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    CloudApiError,
    mcp::mcp_service,
    state::{AppState, StoreError},
};

const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SNAPSHOT_REQUEST_BYTES: usize = MAX_SNAPSHOT_BYTES + 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CloudApiSettings {
    pub enabled: bool,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateSettingsBody {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ApiKeyInfo {
    pub id: String,
    pub name: String,
    pub key_prefix: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CreatedApiKey {
    #[serde(flatten)]
    pub info: ApiKeyInfo,
    pub key: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateApiKeyBody {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SnapshotReceipt {
    pub session_id: String,
    pub revision: i64,
    pub published_at: String,
}

#[derive(Deserialize, ToSchema)]
pub struct PublishSnapshotBody {
    #[serde(flatten)]
    pub export: access::MeetingExport,
    pub source_workspace_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ListMeetingsQuery {
    pub(crate) query: Option<String>,
    pub(crate) series_id: Option<String>,
    pub(crate) limit: Option<u32>,
    pub(crate) offset: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct TranscriptQuery {
    pub(crate) offset: Option<u32>,
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct HistoryQuery {
    pub(crate) limit: Option<u32>,
    pub(crate) offset: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ExportQuery {
    format: Option<String>,
}

pub fn management_router(state: AppState) -> Router {
    Router::new()
        .route(
            "/v1/cloud-api/settings",
            get(get_settings).put(update_settings),
        )
        .route("/v1/cloud-api/keys", get(list_keys).post(create_key))
        .route("/v1/cloud-api/keys/{key_id}", delete(revoke_key))
        .route(
            "/v1/sync-snapshots/{session_id}",
            put(publish_snapshot).delete(delete_snapshot),
        )
        .layer(DefaultBodyLimit::max(MAX_SNAPSHOT_REQUEST_BYTES))
        .with_state(state)
}

pub fn connector_router(state: AppState) -> Router {
    let mcp = mcp_service(state.clone());
    let v1 = Router::new()
        .route("/meetings", get(list_meetings))
        .route("/meetings/{meeting_id}", get(get_meeting))
        .route("/meetings/{meeting_id}/transcript", get(get_transcript))
        .route("/meetings/{meeting_id}/history", get(get_history))
        .route("/meetings/{meeting_id}/export", get(export_meeting));

    Router::new()
        .nest("/v1", v1)
        .nest_service("/mcp", mcp)
        .with_state(state)
}

#[utoipa::path(
    get,
    path = "/v1/cloud-api/settings",
    tag = "cloud-api",
    responses(
        (status = 200, body = CloudApiSettings),
        (status = 403, body = crate::error::ErrorEnvelope)
    )
)]
pub(crate) async fn get_settings(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<CloudApiSettings>, CloudApiError> {
    state
        .get_settings(&auth.claims.sub)
        .await
        .map(Json)
        .map_err(map_store_error)
}

#[utoipa::path(
    put,
    path = "/v1/cloud-api/settings",
    tag = "cloud-api",
    request_body = UpdateSettingsBody,
    responses(
        (status = 200, body = CloudApiSettings),
        (status = 403, body = crate::error::ErrorEnvelope)
    )
)]
pub(crate) async fn update_settings(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<UpdateSettingsBody>,
) -> Result<Json<CloudApiSettings>, CloudApiError> {
    state
        .set_enabled(&auth.claims.sub, body.enabled)
        .await
        .map(Json)
        .map_err(map_store_error)
}

#[utoipa::path(
    get,
    path = "/v1/cloud-api/keys",
    tag = "cloud-api",
    responses(
        (status = 200, body = [ApiKeyInfo]),
        (status = 403, body = crate::error::ErrorEnvelope)
    )
)]
pub(crate) async fn list_keys(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<Vec<ApiKeyInfo>>, CloudApiError> {
    state
        .list_keys(&auth.claims.sub)
        .await
        .map(Json)
        .map_err(map_store_error)
}

#[utoipa::path(
    post,
    path = "/v1/cloud-api/keys",
    tag = "cloud-api",
    request_body = CreateApiKeyBody,
    responses(
        (status = 201, body = CreatedApiKey),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope)
    )
)]
pub(crate) async fn create_key(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<CreateApiKeyBody>,
) -> Result<(StatusCode, Json<CreatedApiKey>), CloudApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > 128 {
        return Err(CloudApiError::InvalidRequest(
            "key name must be between 1 and 128 bytes".to_string(),
        ));
    }
    let key = format!("anl_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let key_hash = Sha256::digest(key.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let key_prefix = &key[..12];
    let info = state
        .create_key(
            &auth,
            &Uuid::new_v4().to_string(),
            name,
            &key_hash,
            key_prefix,
        )
        .await
        .map_err(map_store_error)?;

    Ok((StatusCode::CREATED, Json(CreatedApiKey { info, key })))
}

#[utoipa::path(
    delete,
    path = "/v1/cloud-api/keys/{key_id}",
    tag = "cloud-api",
    params(("key_id" = String, Path, description = "Cloud API key id")),
    responses(
        (status = 204),
        (status = 404, body = crate::error::ErrorEnvelope)
    )
)]
pub(crate) async fn revoke_key(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(key_id): Path<String>,
) -> Result<StatusCode, CloudApiError> {
    if Uuid::parse_str(&key_id).is_err() {
        return Err(CloudApiError::NotFound(format!(
            "API key '{key_id}' not found"
        )));
    }
    if state
        .revoke_key(&auth.claims.sub, &key_id)
        .await
        .map_err(map_store_error)?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(CloudApiError::NotFound(format!(
            "API key '{key_id}' not found"
        )))
    }
}

#[utoipa::path(
    put,
    path = "/v1/sync-snapshots/{session_id}",
    tag = "cloud-api",
    params(("session_id" = String, Path, description = "Shots Founder Hub meeting id")),
    request_body = PublishSnapshotBody,
    responses(
        (status = 200, body = SnapshotReceipt),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope)
    )
)]
pub(crate) async fn publish_snapshot(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(session_id): Path<String>,
    Json(body): Json<PublishSnapshotBody>,
) -> Result<Json<SnapshotReceipt>, CloudApiError> {
    let export = sanitize_export(body.export)?;
    if export.meeting.id != session_id {
        return Err(CloudApiError::InvalidRequest(
            "snapshot meeting id must match the path".to_string(),
        ));
    }
    if let Some(shots) = &auth.shots {
        let source = body
            .source_workspace_id
            .as_deref()
            .filter(|source| Uuid::parse_str(source).is_ok())
            .ok_or_else(|| {
                CloudApiError::InvalidRequest(
                    "source_workspace_id is required for Shots snapshots".into(),
                )
            })?;
        if !shots.allows(source, "artifact:read") {
            return Err(CloudApiError::PermissionDenied);
        }
    }
    state
        .publish_snapshot(
            &auth,
            &session_id,
            &export,
            body.source_workspace_id.as_deref(),
        )
        .await
        .map(Json)
        .map_err(map_store_error)
}

#[utoipa::path(
    delete,
    path = "/v1/sync-snapshots/{session_id}",
    tag = "cloud-api",
    params(("session_id" = String, Path, description = "Shots Founder Hub meeting id")),
    responses((status = 204))
)]
pub(crate) async fn delete_snapshot(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, CloudApiError> {
    state
        .delete_snapshot(&auth.claims.sub, &session_id)
        .await
        .map_err(map_store_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/v1/meetings",
    tag = "cloud-api",
    params(
        ("query" = Option<String>, Query),
        ("series_id" = Option<String>, Query),
        ("limit" = Option<u32>, Query),
        ("offset" = Option<u32>, Query)
    ),
    responses(
        (status = 200, body = access::MeetingPage),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 429, body = String, description = "Cloud API rate limit exceeded")
    )
)]
pub(crate) async fn list_meetings(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Query(params): Query<ListMeetingsQuery>,
) -> Result<Json<access::MeetingPage>, CloudApiError> {
    list_meetings_for_user(&state, &auth.claims.sub, params)
        .await
        .map(Json)
}

pub(crate) async fn list_meetings_for_user(
    state: &AppState,
    user_id: &str,
    params: ListMeetingsQuery,
) -> Result<access::MeetingPage, CloudApiError> {
    let limit = params
        .limit
        .unwrap_or(access::DEFAULT_LIST_LIMIT)
        .clamp(1, access::MAX_LIST_LIMIT);
    let offset = params.offset.unwrap_or(0);
    let mut exports = state
        .list_snapshots(
            user_id,
            params.query.as_deref(),
            params.series_id.as_deref(),
            limit + 1,
            offset,
        )
        .await
        .map_err(map_store_error)?;
    let has_more = exports.len() > limit as usize;
    exports.truncate(limit as usize);
    let meetings = exports
        .iter()
        .map(|export| access::MeetingListItem::from(&export.meeting))
        .collect::<Vec<_>>();

    Ok(access::MeetingPage {
        pagination: access::Pagination {
            offset,
            limit,
            returned: meetings.len(),
            total: None,
            next_offset: has_more.then_some(offset.saturating_add(limit)),
        },
        meetings,
    })
}

#[utoipa::path(
    get,
    path = "/v1/meetings/{meeting_id}",
    tag = "cloud-api",
    params(("meeting_id" = String, Path)),
    responses(
        (status = 200, body = access::Meeting),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 429, body = String, description = "Cloud API rate limit exceeded")
    )
)]
pub(crate) async fn get_meeting(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(meeting_id): Path<String>,
) -> Result<Json<access::Meeting>, CloudApiError> {
    read_export(&state, &auth.claims.sub, &meeting_id)
        .await
        .map(|export| Json(export.meeting))
}

#[utoipa::path(
    get,
    path = "/v1/meetings/{meeting_id}/transcript",
    tag = "cloud-api",
    params(
        ("meeting_id" = String, Path),
        ("offset" = Option<u32>, Query),
        ("limit" = Option<u32>, Query)
    ),
    responses(
        (status = 200, body = access::TranscriptPage),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 429, body = String, description = "Cloud API rate limit exceeded")
    )
)]
pub(crate) async fn get_transcript(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(meeting_id): Path<String>,
    Query(params): Query<TranscriptQuery>,
) -> Result<Json<access::TranscriptPage>, CloudApiError> {
    let export = read_export(&state, &auth.claims.sub, &meeting_id).await?;
    Ok(Json(access::paginate_transcripts(
        &meeting_id,
        &export.transcripts,
        params.offset.unwrap_or(0),
        params.limit.unwrap_or(access::DEFAULT_TRANSCRIPT_LIMIT),
    )))
}

#[utoipa::path(
    get,
    path = "/v1/meetings/{meeting_id}/history",
    tag = "cloud-api",
    params(
        ("meeting_id" = String, Path),
        ("limit" = Option<u32>, Query),
        ("offset" = Option<u32>, Query)
    ),
    responses(
        (status = 200, body = access::MeetingPage),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 429, body = String, description = "Cloud API rate limit exceeded")
    )
)]
pub(crate) async fn get_history(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(meeting_id): Path<String>,
    Query(params): Query<HistoryQuery>,
) -> Result<Json<access::MeetingPage>, CloudApiError> {
    history_for_user(&state, &auth.claims.sub, meeting_id, params)
        .await
        .map(Json)
}

pub(crate) async fn history_for_user(
    state: &AppState,
    user_id: &str,
    meeting_id: String,
    params: HistoryQuery,
) -> Result<access::MeetingPage, CloudApiError> {
    let export = read_export(state, user_id, &meeting_id).await?;
    let limit = params
        .limit
        .unwrap_or(access::DEFAULT_LIST_LIMIT)
        .clamp(1, access::MAX_LIST_LIMIT);
    let offset = params.offset.unwrap_or(0);
    if export.meeting.series_id.trim().is_empty() {
        return Ok(access::MeetingPage {
            meetings: Vec::new(),
            pagination: access::Pagination {
                offset,
                limit,
                returned: 0,
                total: Some(0),
                next_offset: None,
            },
        });
    }
    list_meetings_for_user(
        state,
        user_id,
        ListMeetingsQuery {
            query: None,
            series_id: Some(export.meeting.series_id),
            limit: Some(limit),
            offset: Some(offset),
        },
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v1/meetings/{meeting_id}/export",
    tag = "cloud-api",
    params(
        ("meeting_id" = String, Path),
        ("format" = Option<String>, Query, description = "json or markdown")
    ),
    responses(
        (status = 200, description = "Meeting export"),
        (status = 400, body = crate::error::ErrorEnvelope),
        (status = 401, body = crate::error::ErrorEnvelope),
        (status = 403, body = crate::error::ErrorEnvelope),
        (status = 404, body = crate::error::ErrorEnvelope),
        (status = 429, body = String, description = "Cloud API rate limit exceeded")
    )
)]
pub(crate) async fn export_meeting(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Path(meeting_id): Path<String>,
    Query(params): Query<ExportQuery>,
) -> Result<Response, CloudApiError> {
    let export = read_export(&state, &auth.claims.sub, &meeting_id).await?;
    match params.format.as_deref().unwrap_or("json") {
        "json" => Ok(Json(export).into_response()),
        "markdown" => Ok((
            [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
            export.to_markdown(),
        )
            .into_response()),
        other => Err(CloudApiError::InvalidRequest(format!(
            "unknown format '{other}'; use 'json' or 'markdown'"
        ))),
    }
}

pub(crate) async fn read_export(
    state: &AppState,
    user_id: &str,
    meeting_id: &str,
) -> Result<access::MeetingExport, CloudApiError> {
    state
        .read_snapshot(user_id, meeting_id)
        .await
        .map_err(map_store_error)?
        .ok_or_else(|| CloudApiError::NotFound(format!("meeting '{meeting_id}' not found")))
}

fn sanitize_export(export: access::MeetingExport) -> Result<access::MeetingExport, CloudApiError> {
    let mut value = serde_json::to_value(export)
        .map_err(|error| CloudApiError::InvalidRequest(error.to_string()))?;
    sanitize_value(&mut value);
    let mut export: access::MeetingExport = serde_json::from_value(value)
        .map_err(|error| CloudApiError::InvalidRequest(error.to_string()))?;
    export.meeting.title = export.meeting.title.trim().to_string();
    let bytes = serde_json::to_vec(&export)
        .map_err(|error| CloudApiError::InvalidRequest(error.to_string()))?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(CloudApiError::InvalidRequest(format!(
            "snapshot exceeds the {MAX_SNAPSHOT_BYTES}-byte limit"
        )));
    }
    Ok(export)
}

fn sanitize_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => {
            text.retain(|character| {
                !character.is_control() || matches!(character, '\n' | '\r' | '\t')
            });
        }
        serde_json::Value::Array(values) => {
            for value in values {
                sanitize_value(value);
            }
        }
        serde_json::Value::Object(object) => {
            for key in ["path", "file_path", "audio_path"] {
                object.remove(key);
            }
            for value in object.values_mut() {
                sanitize_value(value);
            }
        }
        _ => {}
    }
}

fn map_store_error(error: StoreError) -> CloudApiError {
    match &error {
        StoreError::Database(anlg_cloud_db::Error::Database {
            reason: Some("permission_denied"),
            ..
        }) => CloudApiError::PermissionDenied,
        StoreError::Database(anlg_cloud_db::Error::Database {
            reason: Some("subscription_required"),
            ..
        }) => CloudApiError::SubscriptionRequired,
        StoreError::Database(anlg_cloud_db::Error::Database {
            reason: Some("cloud_api_not_enabled"),
            ..
        }) => CloudApiError::NotEnabled,
        StoreError::Database(anlg_cloud_db::Error::Database {
            reason: Some("invalid_cloud_api_request"),
            ..
        }) => CloudApiError::InvalidRequest("invalid cloud API request".into()),
        StoreError::Database(anlg_cloud_db::Error::Database { code, .. }) if code == "23514" => {
            CloudApiError::InvalidRequest("invalid cloud API request".into())
        }
        _ => CloudApiError::Internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anlg_api_auth::{AuthState, ShotsAuth, ShotsAuthority, ShotsSession};
    use anlg_cloud_db::Database;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
        middleware,
    };
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{header, method, path},
    };

    async fn fixture() -> (MockServer, AppState, String, Value) {
        let server = MockServer::start().await;
        let db = Database::new(
            &std::env::var("CLOUD_DATABASE_TEST_URL").expect("test PostgreSQL required"),
        )
        .unwrap();
        let id = Uuid::new_v4();
        let workspace = Uuid::new_v4();
        let user =
            json!({"id":id,"email":format!("{id}@example.test"),"name":"Integration","image":null});
        let permissions = json!(["workspace:read", "artifact:read"]);
        let member = json!({"emailVerified":true,"createdAt":"2026-01-01T00:00:00Z","user":user,"accountUserId":id,"role":"owner","permissions":permissions});
        let snapshot = json!({
            "emailVerified":true,"revision":"1","createdAt":"2026-01-01T00:00:00Z","user":user,
            "accountUserId":id,"sessionId":Uuid::new_v4(),"expiresAt":"2099-01-01T00:00:00Z",
            "workspaces":[{"organizationId":workspace,"workspaceId":workspace,"ownerUserId":id,
                "owner":member,"members":[member],"name":"Team","role":"owner","permissions":permissions,"features":{"workspace:paid":true}}]
        });
        let session: ShotsSession = serde_json::from_value(snapshot.clone()).unwrap();
        let authority = ShotsAuthority::new(db.clone());
        authority.project(&session).await.unwrap();
        let auth = anlg_api_auth::AuthContext {
            claims: session.claims(),
            shots: Some(session),
            token: String::new(),
        };
        let shots = ShotsAuth::new(&server.uri(), &"s".repeat(32))
            .unwrap()
            .with_authority(authority);
        let state = AppState::new(
            crate::CloudApiConfig::new(
                db,
                "https://founder-hub-api.example.com/mcp",
                &server.uri(),
            )
            .unwrap(),
        )
        .with_auth(AuthState::new().with_shots(Some(shots)));
        state.set_enabled(&id.to_string(), true).await.unwrap();
        state
            .publish_snapshot(
                &auth,
                "meeting-1",
                &sanitize_export(export()).unwrap(),
                Some(&id.to_string()),
            )
            .await
            .unwrap();
        state
            .read_snapshot(&id.to_string(), "meeting-1")
            .await
            .unwrap();
        state
            .list_snapshots(&id.to_string(), None, None, 20, 0)
            .await
            .unwrap();
        let key = format!("anl_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let key_hash = Sha256::digest(key.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        state
            .create_key(
                &auth,
                &Uuid::new_v4().to_string(),
                "Integration",
                &key_hash,
                &key[..12],
            )
            .await
            .unwrap();
        Mock::given(method("POST"))
            .and(path("/api/founder-hub/key-session"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&snapshot))
            .mount(&server)
            .await;
        (server, state, key, snapshot)
    }

    fn connector(state: AppState) -> Router {
        connector_router(state.clone()).route_layer(middleware::from_fn_with_state(
            state,
            crate::require_cloud_connector_auth,
        ))
    }

    async fn get(app: &Router, token: Option<&str>) -> (StatusCode, Value) {
        let mut request = Request::get("/v1/meetings");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    fn export() -> access::MeetingExport {
        access::MeetingExport {
            meeting: access::Meeting {
                id: "meeting-1".to_string(),
                title: " Planning \0".to_string(),
                kind: "meeting".to_string(),
                status: "completed".to_string(),
                created_at: "2026-07-28".to_string(),
                updated_at: "2026-07-28".to_string(),
                started_at: "2026-07-28".to_string(),
                ended_at: String::new(),
                timezone: "Asia/Seoul".to_string(),
                language: "en".to_string(),
                series_id: String::new(),
                folder_path: None,
                note: None,
                summaries: Vec::new(),
                participants: Vec::new(),
                action_items: Vec::new(),
            },
            transcripts: vec![access::Transcript {
                id: "transcript-1".to_string(),
                source: "mic".to_string(),
                provider: String::new(),
                model: String::new(),
                language: "en".to_string(),
                started_at_ms: 0,
                ended_at_ms: None,
                memo: String::new(),
                text: "hello".to_string(),
                words: vec![serde_json::json!({
                    "text": "hello",
                    "audio_path": "/Users/example/meeting.wav",
                })],
                speaker_hints: Vec::new(),
            }],
            speakers: Vec::new(),
            speaker_context: None,
        }
    }

    #[test]
    fn snapshot_sanitizer_removes_control_characters_and_local_paths() {
        let export = sanitize_export(export()).unwrap();

        assert_eq!(export.meeting.title, "Planning");
        assert!(export.transcripts[0].words[0].get("audio_path").is_none());
    }

    #[tokio::test]
    async fn mcp_supports_stateless_tool_discovery_on_every_public_host() {
        // `sync:3001` is the Host the App Platform gateway sends upstream.
        for host in ["founder-hub-api.example.com", "sync:3001"] {
            assert_mcp_tool_discovery(host).await;
        }
    }

    async fn assert_mcp_tool_discovery(host: &str) {
        let (_server, state, key, _) = fixture().await;
        let app = connector(state);

        let response = app
            .clone()
            .oneshot(
                Request::post("/mcp")
                    .header("host", host)
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .header("mcp-protocol-version", "2026-07-28")
                    .header("mcp-method", "server/discover")
                    .body(Body::from(
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "server/discover",
                            "params": {
                                "_meta": current_mcp_meta(),
                            },
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
        assert!(
            body["result"]["supportedVersions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|version| version == "2026-07-28")
        );

        let response = app
            .oneshot(
                Request::post("/mcp")
                    .header("host", host)
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .header("mcp-protocol-version", "2026-07-28")
                    .header("mcp-method", "tools/list")
                    .body(Body::from(
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "tools/list",
                            "params": {
                                "_meta": current_mcp_meta(),
                            },
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/json"
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
        assert_eq!(body["result"]["tools"].as_array().unwrap().len(), 5);
        assert!(
            body["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "list_meetings")
        );
        assert!(
            body["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "export_meeting")
        );
    }

    fn current_mcp_meta() -> serde_json::Value {
        serde_json::json!({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
                "name": "anarlog-test",
                "version": "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
        })
    }

    #[tokio::test]
    async fn mcp_export_tool_returns_the_complete_snapshot() {
        let (_server, state, key, _) = fixture().await;
        let app = connector(state);

        let response = app
            .oneshot(
                Request::post("/mcp")
                    .header("host", "founder-hub-api.example.com")
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .header("mcp-protocol-version", "2025-11-25")
                    .body(Body::from(
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "tools/call",
                            "params": {
                                "name": "export_meeting",
                                "arguments": { "meeting_id": "meeting-1" },
                            },
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
        assert_eq!(body["result"]["structuredContent"]["id"], "meeting-1");
        assert_eq!(
            body["result"]["structuredContent"]["transcripts"][0]["text"],
            "hello"
        );
    }

    #[tokio::test]
    async fn connector_keys_require_live_paid_authority_and_enabled_access() {
        let (server, state, key, mut snapshot) = fixture().await;
        let app = connector(state.clone());
        for token in [None, Some("anl_invalid"), Some("invalid")] {
            assert_eq!(get(&app, token).await.0, StatusCode::UNAUTHORIZED);
        }
        let (status, body) = get(&app, Some(&key)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["meetings"][0]["id"], "meeting-1");
        assert_eq!(body["pagination"]["returned"], 1);

        state
            .set_enabled(snapshot["accountUserId"].as_str().unwrap(), false)
            .await
            .unwrap();
        let (status, body) = get(&app, Some(&key)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "cloud_api_not_enabled");
        state
            .set_enabled(snapshot["accountUserId"].as_str().unwrap(), true)
            .await
            .unwrap();
        server.reset().await;
        snapshot["revision"] = json!("2");
        snapshot["workspaces"][0]["features"]["workspace:paid"] = json!(false);
        Mock::given(path("/api/founder-hub/key-session"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&snapshot))
            .mount(&server)
            .await;
        let (status, body) = get(&app, Some(&key)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "subscription_required");
        server.reset().await;
        Mock::given(path("/api/founder-hub/key-session"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        assert_eq!(get(&app, Some(&key)).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn connector_routes_validate_shots_oauth_and_reject_revoked_sessions() {
        let (server, state, _, snapshot) = fixture().await;
        for (endpoint, token) in [
            ("session", "session-token"),
            ("connector-session", "connector-token"),
        ] {
            Mock::given(method("GET"))
                .and(path(format!("/api/founder-hub/{endpoint}")))
                .and(header("authorization", format!("Bearer {token}")))
                .respond_with(ResponseTemplate::new(200).set_body_json(&snapshot))
                .mount(&server)
                .await;
        }
        let app = connector(state);
        assert_eq!(get(&app, Some("invalid")).await.0, StatusCode::UNAUTHORIZED);
        for token in ["session-token", "connector-token"] {
            assert_eq!(get(&app, Some(token)).await.0, StatusCode::OK);
        }
        let response = app
            .clone()
            .oneshot(
                Request::post("/mcp")
                    .header("authorization", "Bearer session-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(
            response.headers()["www-authenticate"]
                .to_str()
                .unwrap()
                .contains("founder-hub:meetings:read")
        );
        server.reset().await;
        for token in ["session-token", "connector-token"] {
            assert_eq!(get(&app, Some(token)).await.0, StatusCode::UNAUTHORIZED);
        }
    }
}
