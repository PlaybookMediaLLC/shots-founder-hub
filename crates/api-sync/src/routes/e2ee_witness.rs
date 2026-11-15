mod accepted;

use anlg_api_auth::AuthContext;
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderValue, header},
    routing::get,
};
use serde::{Deserialize, Serialize};
use utoipa::OpenApi;
use uuid::Uuid;

use crate::error::{Result, SyncError};
use crate::state::ReplicaState;

const MAX_EVENTS_PER_BATCH: usize = 64;
const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_WITNESS_REQUEST_BYTES: usize = 64 * 1024 * 1024;
const MAX_WITNESS_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
// Keeps each page short enough to download on slow mobile networks. The first
// event is always returned, so a maximum-size event still fits.
const MAX_WITNESS_PAGE_BYTES: i32 = 16 * 1024 * 1024;
const WITNESS_PAGE_SIZE: i32 = 1024;
const WITNESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const WITNESS_WAIT_HOLD: std::time::Duration = std::time::Duration::from_secs(25);
const WITNESS_WAIT_RECHECK: std::time::Duration = std::time::Duration::from_secs(10);
const WITNESS_WAIT_HEAD_LIMIT: i32 = 1;
const WITNESS_WAIT_HEAD_BYTES: i32 = 1024;

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct E2eeWitnessEvent {
    record_id: String,
    payload_hash: String,
    payload: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishE2eeWitnessRequest {
    initialize: bool,
    events: Vec<E2eeWitnessEvent>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishE2eeWitnessResponse {
    initialized_at: String,
    head_sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadE2eeWitnessQuery {
    #[serde(default)]
    after_sequence: u64,
    through_sequence: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitE2eeWitnessQuery {
    #[serde(default)]
    after_sequence: u64,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct E2eeWitnessWaitResponse {
    initialized: bool,
    head_sequence: u64,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct E2eeWitnessPageEvent {
    sequence: u64,
    record_id: String,
    payload_hash: String,
    payload: String,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct E2eeWitnessPage {
    initialized: bool,
    initialized_at: Option<String>,
    head_sequence: u64,
    through_sequence: u64,
    next_after_sequence: u64,
    events: Vec<E2eeWitnessPageEvent>,
}

#[derive(Serialize)]
struct PublishRpcRequest<'a> {
    p_actor_user_id: &'a str,
    p_workspace_id: &'a str,
    p_initialize: bool,
    p_events: &'a [PublishRpcEvent<'a>],
}

#[derive(Serialize)]
struct PublishRpcEvent<'a> {
    record_id: &'a str,
    payload_hash: &'a str,
    payload: &'a str,
}

#[derive(Serialize)]
struct ReadRpcRequest<'a> {
    p_actor_user_id: &'a str,
    p_workspace_id: &'a str,
    p_after_sequence: i64,
    p_through_sequence: Option<i64>,
    p_limit: i32,
    p_max_bytes: i32,
}

#[derive(Deserialize)]
struct PublishRpcRow {
    initialized_at: String,
    head_sequence: i64,
}

#[derive(Deserialize)]
struct ReadRpcRow {
    initialized_at: Option<String>,
    head_sequence: i64,
    through_sequence: i64,
    event_sequence: Option<i64>,
    record_id: Option<String>,
    payload_hash: Option<String>,
    payload: Option<String>,
}

#[derive(OpenApi)]
#[openapi(
    paths(
        read_e2ee_witness,
        publish_e2ee_witness,
        wait_e2ee_witness,
        accepted::read,
        accepted::accept
    ),
    components(schemas(
        accepted::AcceptRequest,
        accepted::AcceptResponse,
        accepted::Receipt,
        accepted::AcceptedPage,
        E2eeWitnessEvent,
        PublishE2eeWitnessRequest,
        PublishE2eeWitnessResponse,
        E2eeWitnessPageEvent,
        E2eeWitnessPage,
        E2eeWitnessWaitResponse
    ))
)]
pub struct ApiDoc;

pub fn openapi() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}

pub fn router() -> Router<ReplicaState> {
    Router::new()
        .merge(accepted::router())
        .route(
            "/e2ee/witness/{workspace_id}",
            get(read_e2ee_witness).post(publish_e2ee_witness),
        )
        .route("/e2ee/witness/{workspace_id}/wait", get(wait_e2ee_witness))
        .layer(DefaultBodyLimit::max(MAX_WITNESS_REQUEST_BYTES))
}

#[utoipa::path(
    get,
    path = "/e2ee/witness/{workspace_id}",
    tag = "sync",
    params(
        ("workspace_id" = String, Path, description = "Workspace ID"),
        ("afterSequence" = Option<u64>, Query, description = "Last applied witness sequence"),
        ("throughSequence" = Option<u64>, Query, description = "Stable witness page boundary")
    ),
    responses(
        (status = 200, description = "Append-only E2EE witness page", body = E2eeWitnessPage),
        (status = 400, description = "Invalid witness cursor"),
        (status = 401, description = "Authentication required"),
        (status = 403, description = "Witness workspace access denied"),
        (status = 502, description = "Witness service unavailable")
    )
)]
async fn read_e2ee_witness(
    Extension(auth): Extension<AuthContext>,
    State(state): State<ReplicaState>,
    Path(workspace_id): Path<String>,
    Query(query): Query<ReadE2eeWitnessQuery>,
) -> Result<(
    [(header::HeaderName, HeaderValue); 1],
    Json<E2eeWitnessPage>,
)> {
    require_witness_workspace(&auth, &workspace_id, "artifact:read")?;
    let after_sequence = i64::try_from(query.after_sequence)
        .map_err(|_| SyncError::BadRequest("E2EE witness cursor is invalid".to_string()))?;
    let through_sequence = query
        .through_sequence
        .map(i64::try_from)
        .transpose()
        .map_err(|_| SyncError::BadRequest("E2EE witness cursor is invalid".to_string()))?;
    let rows = read_witness_page(
        &state,
        &auth.claims.sub,
        &workspace_id,
        after_sequence,
        through_sequence,
    )
    .await?;
    let page = validate_read_rows(rows, query.after_sequence, query.through_sequence)?;
    Ok((
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(page),
    ))
}

#[utoipa::path(
    get,
    path = "/e2ee/witness/{workspace_id}/wait",
    tag = "sync",
    params(
        ("workspace_id" = String, Path, description = "Workspace ID"),
        ("afterSequence" = Option<u64>, Query, description = "Last witness sequence known to the caller")
    ),
    responses(
        (status = 200, description = "Witness head state, held until it advances past the cursor or the hold expires", body = E2eeWitnessWaitResponse),
        (status = 400, description = "Invalid witness cursor"),
        (status = 401, description = "Authentication required"),
        (status = 403, description = "Witness workspace access denied"),
        (status = 502, description = "Witness service unavailable")
    )
)]
async fn wait_e2ee_witness(
    Extension(auth): Extension<AuthContext>,
    State(state): State<ReplicaState>,
    Path(workspace_id): Path<String>,
    Query(query): Query<WaitE2eeWitnessQuery>,
) -> Result<(
    [(header::HeaderName, HeaderValue); 1],
    Json<E2eeWitnessWaitResponse>,
)> {
    require_witness_workspace(&auth, &workspace_id, "artifact:read")?;
    i64::try_from(query.after_sequence)
        .map_err(|_| SyncError::BadRequest("E2EE witness cursor is invalid".to_string()))?;
    let wake = state.witness_wakes.subscribe(&workspace_id);
    let deadline = tokio::time::Instant::now() + WITNESS_WAIT_HOLD;
    loop {
        let notified = wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let head = read_witness_head(&state, &auth.claims.sub, &workspace_id).await?;
        let now = tokio::time::Instant::now();
        if head.head_sequence > query.after_sequence || !head.initialized || now >= deadline {
            if let Some(shots) = &state.shots {
                let session = auth.shots.as_ref().ok_or(SyncError::E2eeWitnessForbidden)?;
                let current = shots
                    .authenticate(session.access_token())
                    .await
                    .map_err(|_| SyncError::E2eeWitnessForbidden)?;
                require_witness_workspace(&current, &workspace_id, "artifact:read")?;
                if current.claims.sub != auth.claims.sub {
                    return Err(SyncError::E2eeWitnessForbidden);
                }
            }
            return Ok((
                [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
                Json(head),
            ));
        }
        tokio::select! {
            () = &mut notified => {}
            () = tokio::time::sleep(WITNESS_WAIT_RECHECK.min(deadline - now)) => {}
        }
    }
}

async fn read_witness_head(
    state: &ReplicaState,
    actor_user_id: &str,
    workspace_id: &str,
) -> Result<E2eeWitnessWaitResponse> {
    let rows: Vec<ReadRpcRow> = witness_rpc(
        state,
        "read_e2ee_freshness_page_v2",
        &ReadRpcRequest {
            p_actor_user_id: actor_user_id,
            p_workspace_id: workspace_id,
            p_after_sequence: 0,
            p_through_sequence: Some(0),
            p_limit: WITNESS_WAIT_HEAD_LIMIT,
            p_max_bytes: WITNESS_WAIT_HEAD_BYTES,
        },
    )
    .await
    .map_err(map_database_error)?;
    let Some(first) = rows.first() else {
        return Err(SyncError::E2eeWitnessServiceUnavailable);
    };
    let head_sequence =
        u64::try_from(first.head_sequence).map_err(|_| SyncError::E2eeWitnessServiceUnavailable)?;
    Ok(E2eeWitnessWaitResponse {
        initialized: first.initialized_at.is_some(),
        head_sequence,
    })
}

async fn read_witness_page(
    state: &ReplicaState,
    actor_user_id: &str,
    workspace_id: &str,
    after_sequence: i64,
    through_sequence: Option<i64>,
) -> Result<Vec<ReadRpcRow>> {
    witness_rpc(
        state,
        "read_e2ee_freshness_page_v2",
        &ReadRpcRequest {
            p_actor_user_id: actor_user_id,
            p_workspace_id: workspace_id,
            p_after_sequence: after_sequence,
            p_through_sequence: through_sequence,
            p_limit: WITNESS_PAGE_SIZE,
            p_max_bytes: MAX_WITNESS_PAGE_BYTES,
        },
    )
    .await
    .map_err(map_database_error)
}

#[utoipa::path(
    post,
    path = "/e2ee/witness/{workspace_id}",
    tag = "sync",
    params(("workspace_id" = String, Path, description = "Workspace ID")),
    request_body = PublishE2eeWitnessRequest,
    responses(
        (status = 200, description = "Ciphertext events appended", body = PublishE2eeWitnessResponse),
        (status = 400, description = "Invalid witness event"),
        (status = 401, description = "Authentication required"),
        (status = 403, description = "Witness workspace access denied"),
        (status = 409, description = "Legacy witness requires an established device"),
        (status = 503, description = "Publication busy; retry after the Retry-After delay"),
        (status = 502, description = "Witness service unavailable")
    )
)]
async fn publish_e2ee_witness(
    Extension(auth): Extension<AuthContext>,
    State(state): State<ReplicaState>,
    Path(workspace_id): Path<String>,
    Json(request): Json<PublishE2eeWitnessRequest>,
) -> Result<(
    [(header::HeaderName, HeaderValue); 1],
    Json<PublishE2eeWitnessResponse>,
)> {
    require_witness_workspace(&auth, &workspace_id, "artifact:edit")?;
    validate_publish_request(&request)?;
    let _permit = state
        .witness_writes
        .try_acquire(&workspace_id)
        .ok_or(SyncError::E2eeWitnessBusy)?;
    let events = request
        .events
        .iter()
        .map(|event| PublishRpcEvent {
            record_id: &event.record_id,
            payload_hash: &event.payload_hash,
            payload: &event.payload,
        })
        .collect::<Vec<_>>();
    let mut rows: Vec<PublishRpcRow> = witness_rpc(
        &state,
        "publish_e2ee_freshness_events",
        &PublishRpcRequest {
            p_actor_user_id: &auth.claims.sub,
            p_workspace_id: &workspace_id,
            p_initialize: request.initialize,
            p_events: &events,
        },
    )
    .await
    .map_err(map_database_error)?;
    if rows.len() != 1 {
        tracing::warn!(
            row_count = rows.len(),
            "Cloud database E2EE witness publication returned an invalid row count"
        );
        return Err(SyncError::E2eeWitnessServiceUnavailable);
    }
    let row = rows.pop().expect("row count was checked");
    let initialized_at = chrono::DateTime::parse_from_rfc3339(&row.initialized_at)
        .map_err(|_| SyncError::E2eeWitnessServiceUnavailable)?
        .to_rfc3339();
    let head_sequence =
        u64::try_from(row.head_sequence).map_err(|_| SyncError::E2eeWitnessServiceUnavailable)?;
    state.witness_wakes.notify(&workspace_id);
    Ok((
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(PublishE2eeWitnessResponse {
            initialized_at,
            head_sequence,
        }),
    ))
}

fn require_witness_workspace(
    auth: &AuthContext,
    workspace_id: &str,
    permission: &str,
) -> Result<()> {
    if !auth.claims.is_pro() {
        return Err(SyncError::ProPlanRequired);
    }
    if auth
        .shots
        .as_ref()
        .is_some_and(|session| !session.allows(workspace_id, permission))
    {
        return Err(SyncError::E2eeWitnessForbidden);
    }
    let workspace = Uuid::parse_str(workspace_id)
        .map_err(|_| SyncError::BadRequest("E2EE witness workspace is invalid".to_string()))?;
    if workspace.to_string() != workspace_id {
        return Err(SyncError::BadRequest(
            "E2EE witness workspace is invalid".to_string(),
        ));
    }
    Ok(())
}

fn validate_publish_request(request: &PublishE2eeWitnessRequest) -> Result<()> {
    if request.events.is_empty() || request.events.len() > MAX_EVENTS_PER_BATCH {
        return Err(SyncError::BadRequest(
            "E2EE witness event batch is invalid".to_string(),
        ));
    }
    for event in &request.events {
        if !is_blinded_id(&event.record_id)
            || !is_blinded_id(&event.payload_hash)
            || event.payload.is_empty()
            || event.payload.len() > MAX_EVENT_BYTES
        {
            return Err(SyncError::BadRequest(
                "E2EE witness event is invalid".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_read_rows(
    rows: Vec<ReadRpcRow>,
    requested_after: u64,
    requested_through: Option<u64>,
) -> Result<E2eeWitnessPage> {
    let Some(first) = rows.first() else {
        return Err(SyncError::E2eeWitnessServiceUnavailable);
    };
    let raw_head_sequence = first.head_sequence;
    let raw_through_sequence = first.through_sequence;
    let raw_initialized_at = first.initialized_at.clone();
    let head_sequence =
        u64::try_from(raw_head_sequence).map_err(|_| SyncError::E2eeWitnessServiceUnavailable)?;
    let through_sequence = u64::try_from(raw_through_sequence)
        .map_err(|_| SyncError::E2eeWitnessServiceUnavailable)?;
    let initialized_at = raw_initialized_at
        .as_deref()
        .map(chrono::DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| SyncError::E2eeWitnessServiceUnavailable)?
        .map(|value| value.to_rfc3339());
    if requested_after > through_sequence
        || through_sequence > head_sequence
        || requested_through.is_some_and(|value| value != through_sequence)
        || (initialized_at.is_none() && (head_sequence != 0 || rows.len() != 1))
    {
        return Err(SyncError::E2eeWitnessServiceUnavailable);
    }

    let mut events = Vec::with_capacity(rows.len());
    let mut previous = requested_after;
    for row in rows {
        if row.head_sequence != raw_head_sequence
            || row.through_sequence != raw_through_sequence
            || row.initialized_at != raw_initialized_at
        {
            return Err(SyncError::E2eeWitnessServiceUnavailable);
        }
        let Some(sequence) = row.event_sequence else {
            if row.record_id.is_some() || row.payload_hash.is_some() || row.payload.is_some() {
                return Err(SyncError::E2eeWitnessServiceUnavailable);
            }
            continue;
        };
        let sequence =
            u64::try_from(sequence).map_err(|_| SyncError::E2eeWitnessServiceUnavailable)?;
        let (Some(record_id), Some(payload_digest), Some(payload)) =
            (row.record_id, row.payload_hash, row.payload)
        else {
            return Err(SyncError::E2eeWitnessServiceUnavailable);
        };
        if sequence <= previous
            || sequence > through_sequence
            || !is_blinded_id(&record_id)
            || !is_blinded_id(&payload_digest)
            || payload.is_empty()
            || payload.len() > MAX_EVENT_BYTES
        {
            return Err(SyncError::E2eeWitnessServiceUnavailable);
        }
        previous = sequence;
        events.push(E2eeWitnessPageEvent {
            sequence,
            record_id,
            payload_hash: payload_digest,
            payload,
        });
    }

    Ok(E2eeWitnessPage {
        initialized: initialized_at.is_some(),
        initialized_at,
        head_sequence,
        through_sequence,
        next_after_sequence: previous,
        events,
    })
}

async fn witness_rpc<T: serde::de::DeserializeOwned>(
    state: &ReplicaState,
    function: &str,
    request: &impl Serialize,
) -> std::result::Result<T, anlg_cloud_db::Error> {
    tokio::time::timeout(
        WITNESS_TIMEOUT,
        state.config.database.rpc_bounded(
            &anlg_cloud_db::Principal::Service,
            function,
            request,
            MAX_WITNESS_RESPONSE_BYTES,
        ),
    )
    .await
    .map_err(|_| anlg_cloud_db::Error::InvalidResponse)?
}

fn map_database_error(error: anlg_cloud_db::Error) -> SyncError {
    match error {
        anlg_cloud_db::Error::Database { code, .. } => match code.as_str() {
            "42501" => SyncError::E2eeWitnessForbidden,
            "22023" => SyncError::BadRequest("E2EE witness request is invalid".into()),
            "A0002" => SyncError::CloudsyncUpgradeRequired,
            "55000" => SyncError::E2eeWitnessUninitialized,
            "55P03" => SyncError::E2eeWitnessBusy,
            _ => SyncError::E2eeWitnessServiceUnavailable,
        },
        _ => SyncError::E2eeWitnessServiceUnavailable,
    }
}

fn is_blinded_id(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    const RECORD_ID: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const PAYLOAD_HASH: &str = "bSKYhMEmi7CrMtjaMV0P5S-RRyKL2DCje8n7KKlUlA0";
    #[test]
    fn accepts_the_database_publish_batch_limit() {
        let event = E2eeWitnessEvent {
            record_id: RECORD_ID.to_string(),
            payload_hash: PAYLOAD_HASH.to_string(),
            payload: "opaque".to_string(),
        };
        assert!(
            validate_publish_request(&PublishE2eeWitnessRequest {
                initialize: false,
                events: vec![event.clone(); 64],
            })
            .is_ok()
        );
        assert!(
            validate_publish_request(&PublishE2eeWitnessRequest {
                initialize: false,
                events: vec![event; 65],
            })
            .is_err()
        );
    }
}
