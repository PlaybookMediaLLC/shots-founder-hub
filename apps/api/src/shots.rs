use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anlg_api_auth::{AuthState, ShotsAuth, ShotsSession};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, OriginalUri, Query, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone)]
struct Gateway {
    shots: ShotsAuth,
    client: reqwest::Client,
    storage_origin: reqwest::Url,
    anon_key: String,
}

pub fn router(shots: ShotsAuth, storage_origin: &str, anon_key: &str) -> Router {
    Router::new()
        .route("/auth/v1/user", get(user))
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
        .route("/rest/v1/{*path}", any(data))
        .route("/storage/v1/{*path}", any(data))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(Gateway {
            shots,
            storage_origin: reqwest::Url::parse(storage_origin).expect("validated storage origin"),
            anon_key: anon_key.to_owned(),
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
    match state
        .shots
        .settings(token, path, uri.query(), method, body.to_vec())
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

async fn data(State(state): State<Gateway>, request: Request) -> Response {
    let path = request.uri().path();
    let path = path.strip_prefix("/cloud").unwrap_or(path);
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2f")
        || lower.contains("%5c")
        || lower.contains("%2e")
        || path.contains('\\')
    {
        return error(StatusCode::BAD_REQUEST, "invalid_storage_path");
    }
    let storage = path.starts_with("/storage/v1/");
    if !storage && !rest_path_allowed(path) {
        return error(StatusCode::FORBIDDEN, "shots_operation_required");
    }
    let mut url = match state.storage_origin.join(path) {
        Ok(url) => url,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_storage_path"),
    };
    if url.path() != path {
        return error(StatusCode::BAD_REQUEST, "invalid_storage_path");
    }
    url.set_query(request.uri().query());
    let token = if request.headers().contains_key("authorization") {
        let token = match access_token(request.headers()) {
            Ok(token) => token,
            Err(response) => return response,
        };
        match state.shots.authenticate(token).await {
            Ok(auth) => auth.token,
            Err(anlg_supabase_auth::server::Error::InvalidToken) => {
                return error(StatusCode::UNAUTHORIZED, "invalid_token");
            }
            Err(_) => return error(StatusCode::BAD_GATEWAY, "shots_storage_unavailable"),
        }
    } else {
        let signed = storage
            && (path.starts_with("/storage/v1/object/sign/")
                || path.starts_with("/storage/v1/object/upload/sign/")
                || path.starts_with("/storage/v1/upload/resumable/")
                    && request.headers().contains_key("x-signature"));
        let public_read = path.starts_with("/storage/v1/object/public/")
            && matches!(
                *request.method(),
                axum::http::Method::GET | axum::http::Method::HEAD
            );
        if !signed && !public_read {
            return error(StatusCode::UNAUTHORIZED, "invalid_token");
        }
        state.anon_key.clone()
    };
    let (parts, body) = request.into_parts();
    let mut headers = HeaderMap::new();
    for name in [
        "accept",
        "content-type",
        "content-length",
        "prefer",
        "range",
        "range-unit",
        "content-range",
        "if-match",
        "if-none-match",
        "cache-control",
        "x-upsert",
        "tus-resumable",
        "upload-length",
        "upload-offset",
        "upload-metadata",
        "upload-defer-length",
        "upload-concat",
        "x-signature",
    ] {
        if let Some(value) = parts.headers.get(name) {
            headers.insert(name, value.clone());
        }
    }
    let response = state
        .client
        .request(parts.method, url)
        .headers(headers)
        .timeout(Duration::from_secs(600))
        .header("apikey", &state.anon_key)
        .bearer_auth(token)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "storage_unavailable"),
    };
    let status = response.status();
    let mut headers = response.headers().clone();
    crate::proxy::strip_hop_headers(&mut headers);
    headers.remove("set-cookie");
    headers.insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store"),
    );
    if let Some(location) = headers.get("location") {
        let target = location
            .to_str()
            .ok()
            .and_then(|location| state.storage_origin.join(location).ok());
        let Some(target) = target.filter(|target| {
            target.origin() == state.storage_origin.origin()
                && target.path().starts_with("/storage/v1/")
        }) else {
            return error(StatusCode::BAD_GATEWAY, "invalid_storage_redirect");
        };
        let rewritten = format!(
            "/cloud{}{}",
            target.path(),
            target.query().map(|q| format!("?{q}")).unwrap_or_default()
        );
        let Ok(value) = rewritten.parse() else {
            return error(StatusCode::BAD_GATEWAY, "invalid_storage_redirect");
        };
        headers.insert("location", value);
    }
    (status, headers, Body::from_stream(response.bytes_stream())).into_response()
}

fn rest_path_allowed(path: &str) -> bool {
    if matches!(
        path,
        "/rest/v1/profiles"
            | "/rest/v1/workspaces"
            | "/rest/v1/workspace_memberships"
            | "/rest/v1/sync_devices"
    ) {
        return true;
    }
    let Some(function) = path.strip_prefix("/rest/v1/rpc/") else {
        return false;
    };
    matches!(
        function,
        "get_workspace_access"
            | "list_workspace_members_with_profiles"
            | "get_workspace_seat_usage"
            | "get_referral_summary"
            | "get_pro_trial_offer"
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
        anlg_supabase_auth::server::Error::InvalidToken => {
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
