use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anlg_api_auth::{AuthState, ShotsAuth, ShotsSession};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, OriginalUri, Query, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone)]
struct Gateway {
    shots: ShotsAuth,
    client: reqwest::Client,
    database: anlg_cloud_db::Database,
}

pub fn router(shots: ShotsAuth, database: anlg_cloud_db::Database) -> Router {
    Router::new()
        .route("/auth/v1/user", get(user))
        .route("/auth/v1/claims", get(claims))
        .route("/auth/v1/token", post(token))
        .route("/auth/v1/logout", post(logout))
        .route(
            "/settings",
            get(settings)
                .patch(settings)
                .layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route("/settings/devices", get(settings))
        .route(
            "/settings/devices/report",
            post(settings).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/settings/devices/commands",
            post(settings).layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route(
            "/settings/devices/commands/{id}",
            get(settings)
                .patch(settings)
                .layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route("/settings/templates", get(settings))
        .route(
            "/settings/templates/{id}",
            axum::routing::patch(settings).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/voice/{*path}",
            get(voice)
                .post(voice)
                .put(voice)
                .patch(voice)
                .delete(voice)
                .layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route("/data/rpc/{function}", post(rpc))
        .route("/data/workspaces", get(workspaces))
        .route("/data/devices", get(devices))
        .route("/data/devices/{id}", axum::routing::delete(delete_device))
        .route("/data/profile", get(profile))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(axum::middleware::map_response(
            |mut response: Response| async move {
                response
                    .headers_mut()
                    .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
                response
            },
        ))
        .with_state(Gateway {
            shots,
            database,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_zstd()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("HTTP client"),
        })
}

async fn settings(
    State(state): State<Gateway>,
    OriginalUri(uri): OriginalUri,
    method: axum::http::Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let token = match access_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let path = uri.path().strip_prefix("/cloud/settings").unwrap_or("");
    if !path
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"/-_".contains(&byte))
    {
        return error(StatusCode::BAD_REQUEST, "invalid_settings_path");
    }
    let path = if path.is_empty() {
        "settings"
    } else {
        &path[1..]
    };
    if uri.query().is_some_and(|query| query.len() > 2048) {
        return error(StatusCode::BAD_REQUEST, "invalid_settings_query");
    }
    let json = HeaderMap::from_iter([(CONTENT_TYPE, HeaderValue::from_static("application/json"))]);
    match state
        .shots
        .forward(
            token,
            path,
            uri.query(),
            method,
            json,
            body.to_vec(),
            Duration::from_secs(10),
        )
        .await
    {
        Ok(response) => {
            let status = response.status();
            (
                status,
                [
                    ("content-type", "application/json"),
                    ("cache-control", "no-store"),
                ],
                Body::from_stream(response.bytes_stream()),
            )
                .into_response()
        }
        Err(_) => error(StatusCode::BAD_GATEWAY, "shots_settings_unavailable"),
    }
}

// Shots verifies the bearer token and workspace membership, as for settings. Bodies hold
// transcript text: never log them.
async fn voice(
    State(state): State<Gateway>,
    OriginalUri(uri): OriginalUri,
    method: axum::http::Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let token = match access_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let path = uri.path().strip_prefix("/cloud/voice/").unwrap_or("");
    if path.split('/').count() > 8
        || path.split('/').any(|segment| {
            segment.is_empty()
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        })
    {
        return error(StatusCode::NOT_FOUND, "invalid_voice_path");
    }
    if uri.query().is_some_and(|query| query.len() > 2048) {
        return error(StatusCode::BAD_REQUEST, "invalid_voice_query");
    }
    let mut forwarded = HeaderMap::new();
    for name in [CONTENT_TYPE.as_str(), "x-shots-organization-id"] {
        if let Some(value) = headers.get(name) {
            forwarded.insert(name, value.clone());
        }
    }
    match state
        .shots
        .forward(
            token,
            &format!("voice/{path}"),
            uri.query(),
            method,
            forwarded,
            body.to_vec(),
            // Shots verifies an uploaded run (up to about 60 MB) and parses a
            // transcript within the request.
            Duration::from_secs(120),
        )
        .await
    {
        Ok(response) => {
            let mut headers = HeaderMap::new();
            if let Some(value) = response.headers().get(CONTENT_TYPE) {
                headers.insert(CONTENT_TYPE, value.clone());
            }
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            (
                response.status(),
                headers,
                Body::from_stream(response.bytes_stream()),
            )
                .into_response()
        }
        Err(_) => error(StatusCode::BAD_GATEWAY, "shots_voice_unavailable"),
    }
}

async fn principal(
    state: &Gateway,
    headers: &HeaderMap,
) -> Result<anlg_cloud_db::Principal, Response> {
    let token = access_token(headers)?;
    state
        .shots
        .authenticate(token)
        .await
        .map_err(|error| match error {
            anlg_session_auth::server::Error::InvalidToken => {
                error_response(StatusCode::UNAUTHORIZED, "invalid_token")
            }
            _ => error_response(StatusCode::BAD_GATEWAY, "session_authority_unavailable"),
        })?
        .principal()
        .map_err(IntoResponse::into_response)
}

fn error_response(status: StatusCode, code: &str) -> Response {
    error(status, code)
}

fn database_error(error: anlg_cloud_db::Error) -> Response {
    let (status, code) = match &error {
        anlg_cloud_db::Error::Database { code, .. } if code == "42501" => {
            (StatusCode::FORBIDDEN, code.as_str())
        }
        anlg_cloud_db::Error::Database { code, .. }
            if code.starts_with("22") || code == "23514" =>
        {
            (StatusCode::BAD_REQUEST, code.as_str())
        }
        anlg_cloud_db::Error::Database { code, .. } if code == "23505" || code == "40001" => {
            (StatusCode::CONFLICT, code.as_str())
        }
        anlg_cloud_db::Error::InvalidOperation => (StatusCode::BAD_REQUEST, "invalid_operation"),
        _ => (StatusCode::BAD_GATEWAY, "database_unavailable"),
    };
    error_response(status, code)
}

async fn rpc(
    State(state): State<Gateway>,
    axum::extract::Path(function): axum::extract::Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    // Signed-out visitors check share slugs and referral links.
    if matches!(
        function.as_str(),
        "workspace_share_slug_is_active" | "referral_link_available"
    ) {
        return match state
            .database
            .rpc_bounded::<Value>(&anlg_cloud_db::Principal::Anonymous, &function, &body, 1024)
            .await
        {
            Ok(value) => Json(value).into_response(),
            Err(error) => database_error(error),
        };
    }
    if !rpc_allowed(&function) {
        return error(StatusCode::NOT_FOUND, "unknown_operation");
    }
    let principal = match principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    match state
        .database
        .rpc_bounded::<Value>(&principal, &function, &body, 16 * 1024 * 1024)
        .await
    {
        Ok(data) => Json(data).into_response(),
        Err(error) => database_error(error),
    }
}

async fn workspaces(State(state): State<Gateway>, headers: HeaderMap) -> Response {
    use anlg_cloud_db::entities::{workspace, workspace_membership as membership};
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
    let principal = match principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    let anlg_cloud_db::Principal::User { user_id, .. } = &principal else {
        return error(StatusCode::UNAUTHORIZED, "invalid_token");
    };
    let result = async {
        let tx = state.database.transaction(&principal).await?;
        let rows = membership::Entity::find()
            .filter(membership::Column::UserId.eq(*user_id))
            .filter(membership::Column::DeletedAt.is_null())
            .find_also_related(workspace::Entity)
            .filter(workspace::Column::Kind.eq("shared"))
            .filter(workspace::Column::DeletedAt.is_null())
            .order_by_asc(workspace::Column::Name)
            .limit(1000)
            .all(&tx)
            .await?;
        let rows: Vec<Value> = rows
            .into_iter()
            .filter_map(|(member, workspace)| {
                workspace.map(|row| json!({
            "id": row.id, "name": row.name, "kind": row.kind, "owner_user_id": row.owner_user_id,
            "share_slug": row.share_slug, "logo_data": row.logo_data,
            "workspace_memberships": [{"role":member.role}]
        }))
            })
            .collect();
        tx.commit().await?;
        Ok::<_, anlg_cloud_db::Error>(rows)
    }
    .await;
    match result {
        Ok(rows) => Json(rows).into_response(),
        Err(error) => database_error(error),
    }
}

async fn devices(State(state): State<Gateway>, headers: HeaderMap) -> Response {
    use anlg_cloud_db::entities::sync_device;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
    let principal = match principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    let anlg_cloud_db::Principal::User { user_id, .. } = &principal else {
        return error(StatusCode::UNAUTHORIZED, "invalid_token");
    };
    let result = async {
        let tx = state.database.transaction(&principal).await?;
        let rows = sync_device::Entity::find()
            .filter(sync_device::Column::UserId.eq(*user_id))
            .order_by_desc(sync_device::Column::LastSeenAt)
            .limit(1000)
            .all(&tx)
            .await?;
        tx.commit().await?;
        Ok::<_, anlg_cloud_db::Error>(rows)
    }
    .await;
    match result {
        Ok(rows) => Json(rows).into_response(),
        Err(error) => database_error(error),
    }
}

async fn delete_device(
    State(state): State<Gateway>,
    axum::extract::Path(id): axum::extract::Path<uuid::Uuid>,
    headers: HeaderMap,
) -> Response {
    use anlg_cloud_db::entities::sync_device;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
    let principal = match principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    let anlg_cloud_db::Principal::User { user_id, .. } = &principal else {
        return error(StatusCode::UNAUTHORIZED, "invalid_token");
    };
    let result = async {
        let tx = state.database.transaction(&principal).await?;
        sync_device::Entity::delete_by_id(id)
            .filter(sync_device::Column::UserId.eq(*user_id))
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok::<_, anlg_cloud_db::Error>(())
    }
    .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => database_error(error),
    }
}

async fn profile(State(state): State<Gateway>, headers: HeaderMap) -> Response {
    use sea_orm::EntityTrait;
    let principal = match principal(&state, &headers).await {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    let anlg_cloud_db::Principal::User { user_id, .. } = &principal else {
        return error(StatusCode::UNAUTHORIZED, "invalid_token");
    };
    let result = async {
        let tx = state.database.transaction(&principal).await?;
        let row = anlg_cloud_db::entities::profile::Entity::find_by_id(*user_id)
            .one(&tx)
            .await?;
        tx.commit().await?;
        Ok::<_, anlg_cloud_db::Error>(row)
    }
    .await;
    match result {
        Ok(row) => Json(row).into_response(),
        Err(error) => database_error(error),
    }
}

fn rpc_allowed(function: &str) -> bool {
    matches!(
        function,
        "get_workspace_access"
            | "list_workspace_members_with_profiles"
            | "get_workspace_seat_usage"
            | "get_referral_summary"
            | "get_pro_trial_offer"
            | "claim_referral"
            | "get_workspace_policy"
            | "create_session_share"
            | "delete_session_share"
            | "delete_session_share_by_session"
            | "set_session_share_scope"
            | "get_session_share_management"
            | "get_session_share_workspace_slug"
            | "enable_session_share_link"
            | "rotate_session_share_link"
            | "list_session_share_access"
            | "list_session_share_access_page"
            | "create_session_access_invitation"
            | "resend_session_access_invitation"
            | "revoke_session_access_invitation"
            | "revoke_session_access_grant"
            | "update_session_access_grant"
            | "review_session_access_request"
            | "list_session_share_comments"
            | "create_session_share_comment"
            | "delete_session_share_comment"
            | "request_session_access"
            | "cancel_session_access_request"
            | "get_my_session_access_request"
            | "inspect_my_session_access_invitation"
            | "accept_session_access_invitation"
            | "read_my_session_share_snapshot_v2"
            | "list_my_session_share_snapshot_page_v2"
            | "acknowledge_session_share_web_edits"
            | "list_my_session_share_event_keys"
            | "list_my_accessible_sessions"
            | "list_my_managed_share_gallery_page"
            | "upsert_shared_resource"
            | "move_shared_resource"
            | "delete_shared_resource"
            | "list_shared_resources"
            | "list_shared_resource_guests"
            | "grant_shared_resource_access"
            | "revoke_shared_resource_access"
    )
}

fn error(status: StatusCode, code: &str) -> Response {
    (
        status,
        Json(json!({"code": code, "error_code": code, "msg": code})),
    )
        .into_response()
}

fn access_token(headers: &HeaderMap) -> Result<&str, Response> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(AuthState::extract_token)
        .filter(|token| token.len() <= 16384)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "invalid_token"))
}

fn user_json(session: &ShotsSession) -> Value {
    json!({
        "id": session.account_user_id,
        "aud": "authenticated",
        "role": "authenticated",
        "email": session.user.email,
        "created_at": session.created_at,
        "app_metadata": { "provider": "shots", "providers": ["shots"], "shots_user_id": session.user.id },
        "user_metadata": { "full_name": session.user.name, "name": session.user.name, "avatar_url": session.user.image },
        "identities": [],
        "is_anonymous": false
    })
}

async fn session(state: &Gateway, token: &str) -> Result<ShotsSession, Response> {
    state.shots.session(token).await.map_err(|err| match err {
        anlg_session_auth::server::Error::InvalidToken => {
            error(StatusCode::UNAUTHORIZED, "invalid_token")
        }
        _ => error(StatusCode::BAD_GATEWAY, "shots_unavailable"),
    })
}

async fn user(State(state): State<Gateway>, headers: HeaderMap) -> Response {
    let token = match access_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match session(&state, token).await {
        Ok(current) => Json(user_json(&current)).into_response(),
        Err(response) => response,
    }
}

async fn claims(State(state): State<Gateway>, headers: HeaderMap) -> Response {
    let token = match access_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match session(&state, token).await {
        Ok(current) => Json(current.claims()).into_response(),
        Err(response) => response,
    }
}

#[derive(Deserialize)]
struct Grant {
    grant_type: String,
}

#[derive(Deserialize)]
struct TokenRequest {
    code: Option<String>,
    code_verifier: Option<String>,
    redirect_uri: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

async fn token(
    State(state): State<Gateway>,
    Query(grant): Query<Grant>,
    Json(body): Json<TokenRequest>,
) -> Response {
    let mut form = vec![
        ("client_id", "shots-founder-hub".to_string()),
        (
            "resource",
            state
                .shots
                .origin()
                .join("api/founder-hub")
                .expect("fixed path")
                .to_string(),
        ),
        ("grant_type", grant.grant_type.clone()),
    ];
    match grant.grant_type.as_str() {
        "authorization_code" => {
            let (Some(code), Some(verifier), Some(redirect)) =
                (body.code, body.code_verifier, body.redirect_uri)
            else {
                return error(StatusCode::BAD_REQUEST, "invalid_grant");
            };
            if !(43..=128).contains(&verifier.len()) || code.len() > 512 || redirect.len() > 2048 {
                return error(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            form.extend([
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", redirect),
            ]);
        }
        "refresh_token" => {
            let Some(refresh) = body
                .refresh_token
                .filter(|value| !value.is_empty() && value.len() <= 4096)
            else {
                return error(StatusCode::BAD_REQUEST, "refresh_token_not_found");
            };
            form.push(("refresh_token", refresh));
        }
        _ => return error(StatusCode::BAD_REQUEST, "unsupported_grant_type"),
    }
    let response = match state
        .client
        .post(
            state
                .shots
                .origin()
                .join("api/auth/oauth2/token")
                .expect("fixed path"),
        )
        .form(&form)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "shots_unavailable"),
    };
    if matches!(response.status().as_u16(), 400 | 401) {
        return error(
            StatusCode::BAD_REQUEST,
            if grant.grant_type == "refresh_token" {
                "refresh_token_not_found"
            } else {
                "invalid_grant"
            },
        );
    }
    if !response.status().is_success() {
        return error(StatusCode::BAD_GATEWAY, "shots_unavailable");
    }
    let tokens: Tokens = match response.json().await {
        Ok(tokens) => tokens,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "invalid_shots_response"),
    };
    let current = match session(&state, &tokens.access_token).await {
        Ok(current) => current,
        Err(response) => return response,
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs();
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "access_token": tokens.access_token, "refresh_token": tokens.refresh_token,
            "token_type": "bearer", "expires_in": tokens.expires_in,
            "expires_at": now.saturating_add(tokens.expires_in), "user": user_json(&current)
        })),
    )
        .into_response()
}

async fn logout(
    State(state): State<Gateway>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if query.get("scope").map(String::as_str) != Some("local") {
        return error(StatusCode::BAD_REQUEST, "manage_other_sessions_in_shots");
    }
    let token = match access_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match state.shots.logout(token).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        _ => error(StatusCode::BAD_GATEWAY, "shots_unavailable"),
    }
}
