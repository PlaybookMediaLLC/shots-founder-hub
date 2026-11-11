use anlg_api_auth::AuthContext;
use axum::{
    Extension, Json, Router,
    extract::{
        Path, Query, State,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    response::Response,
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use utoipa::OpenApi;
use uuid::Uuid;

use crate::error::{Result, SyncError};
use crate::live_docs::{
    ControlMessage, LIVE_TICKET_TTL, LiveAccess, LiveCapability, LiveTicket, MAX_LIVE_UPDATE_BYTES,
    Outbound, PEER_OUTBOUND_CAPACITY, control_frame, issue_ticket, resolve_access, verify_ticket,
};
use crate::state::AppState;

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct LiveTicketResponse {
    ticket: String,
    capability: LiveCapability,
    content_revision: i64,
    expires_in_seconds: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    requires_auth: bool,
}

#[derive(Deserialize)]
pub(super) struct LiveSocketQuery {
    ticket: String,
}

#[derive(OpenApi)]
#[openapi(
    paths(create_live_ticket),
    components(schemas(LiveTicketResponse, LiveCapability))
)]
struct ApiDoc;

pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}

pub(super) fn ticket_router() -> Router<AppState> {
    Router::new().route("/shares/{share_id}/live/ticket", post(create_live_ticket))
}

pub(super) fn socket_router() -> Router<AppState> {
    Router::new().route("/shares/{share_id}/live", get(live_socket))
}

fn canonical_share_id(value: &str) -> Result<String> {
    let uuid = Uuid::parse_str(value)
        .map_err(|_| SyncError::BadRequest("Shared note ID is invalid".to_string()))?;
    if uuid.to_string() != value || uuid.get_version() != Some(uuid::Version::Random) {
        return Err(SyncError::BadRequest(
            "Shared note ID is invalid".to_string(),
        ));
    }
    Ok(value.to_string())
}

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Issues a short-lived, HMAC-signed ticket that authorizes one WebSocket
/// connection to a shared note's live document. Browsers cannot attach a bearer
/// header to a WebSocket upgrade. Central sessions authenticate in the first
/// socket frame, keeping the bearer credential out of URLs and access logs.
#[utoipa::path(
    post,
    path = "/shares/{share_id}/live/ticket",
    tag = "sync",
    params(("share_id" = String, Path, description = "Shared note ID")),
    responses(
        (status = 200, body = LiveTicketResponse),
        (status = 403, description = "No access to the shared note"),
        (status = 404, description = "Shared note not found"),
    ),
    security(("bearer" = []))
)]
async fn create_live_ticket(
    Extension(auth): Extension<AuthContext>,
    State(state): State<AppState>,
    Path(share_id): Path<String>,
) -> Result<Json<LiveTicketResponse>> {
    let share_id = canonical_share_id(&share_id)?;
    let access = resolve_access(&state, &share_id, &auth.claims.sub).await?;
    let ticket = issue_ticket(
        &state.config.supabase_service_role_key,
        &auth.claims.sub,
        &access,
        now_unix(),
        auth.shots
            .as_ref()
            .map(|session| session.session_id.as_str()),
    );
    Ok(Json(LiveTicketResponse {
        ticket,
        capability: access.capability,
        content_revision: access.content_revision,
        expires_in_seconds: LIVE_TICKET_TTL.as_secs(),
        requires_auth: auth.shots.is_some(),
    }))
}

async fn live_socket(
    State(state): State<AppState>,
    Path(share_id): Path<String>,
    Query(query): Query<LiveSocketQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let share_id = canonical_share_id(&share_id)?;
    let ticket = verify_ticket(
        &state.config.supabase_service_role_key,
        &query.ticket,
        now_unix(),
    )
    .filter(|ticket| ticket.share_id == share_id)
    .filter(|ticket| ticket.shots_session_id.is_some() == state.replica.shots.is_some())
    .ok_or(SyncError::SnapshotPublicationForbidden)?;
    Ok(ws
        .max_message_size(MAX_LIVE_UPDATE_BYTES + 1024)
        .max_frame_size(MAX_LIVE_UPDATE_BYTES + 1024)
        .on_upgrade(move |socket| run_socket(state, socket, ticket)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveAuthentication {
    access_token: String,
}

async fn resolve_connection_access(
    state: &AppState,
    ticket: &LiveTicket,
    access_token: Option<&str>,
) -> Result<LiveAccess> {
    if let Some(shots) = &state.replica.shots {
        let auth = shots
            .authenticate(access_token.ok_or(SyncError::SnapshotPublicationForbidden)?)
            .await
            .map_err(|_| SyncError::SnapshotPublicationForbidden)?;
        if auth.claims.sub != ticket.user_id
            || auth.shots.as_ref().map(|session| &session.session_id)
                != ticket.shots_session_id.as_ref()
        {
            return Err(SyncError::SnapshotPublicationForbidden);
        }
    }
    let access = resolve_access(state, &ticket.share_id, &ticket.user_id).await?;
    if access.capability != ticket.capability {
        return Err(SyncError::SnapshotPublicationForbidden);
    }
    Ok(access)
}

async fn run_socket(state: AppState, mut socket: WebSocket, ticket: LiveTicket) {
    let access_token = if state.replica.shots.is_some() {
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.recv()).await;
        let auth = match message {
            Ok(Some(Ok(WsMessage::Text(text)))) if text.len() <= 8192 => {
                serde_json::from_str::<LiveAuthentication>(&text).ok()
            }
            _ => None,
        };
        let Some(auth) = auth else {
            let _ = socket.send(WsMessage::Close(None)).await;
            return;
        };
        Some(auth.access_token)
    } else {
        None
    };
    if resolve_connection_access(&state, &ticket, access_token.as_deref())
        .await
        .is_err()
    {
        let _ = socket.send(WsMessage::Close(None)).await;
        return;
    }
    let share_id = &ticket.share_id;
    let user_id = &ticket.user_id;
    let capability = ticket.capability;
    let (mut sink, mut stream) = socket.split();
    let (sender, mut outbound) = mpsc::channel::<Outbound>(PEER_OUTBOUND_CAPACITY);
    let docs = state.live_docs.clone();
    let (live, peer_id, handshake, seed_required) = match docs.join(&state, &share_id, sender).await
    {
        Ok(joined) => joined,
        Err(error) => {
            tracing::warn!(%error, %share_id, "live document could not be loaded");
            let _ = sink.send(WsMessage::Close(None)).await;
            return;
        }
    };

    let ready = control_frame(&ControlMessage::Ready {
        capability,
        content_revision: ticket.content_revision,
        seed_required: seed_required && capability == LiveCapability::Editor,
    });
    let mut initial = std::collections::VecDeque::from([Outbound::Control(ready)]);
    initial.extend(handshake.into_iter().map(Outbound::Binary));
    let writer = async {
        loop {
            let frame = match initial.pop_front() {
                Some(frame) => frame,
                None => match outbound.recv().await {
                    Some(frame) => frame,
                    None => break,
                },
            };
            // All content, including queued updates and handshake state, crosses this gate.
            if resolve_connection_access(&state, &ticket, access_token.as_deref())
                .await
                .is_err()
            {
                break;
            }
            let message = match frame {
                Outbound::Binary(bytes) => WsMessage::Binary(bytes.into()),
                Outbound::Control(text) => WsMessage::Text(text.into()),
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
    };

    let reader = async {
        while let Some(Ok(message)) = stream.next().await {
            let frame = match message {
                WsMessage::Binary(bytes) => bytes,
                WsMessage::Close(_) => break,
                WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Text(_) => continue,
            };
            if resolve_connection_access(&state, &ticket, access_token.as_deref())
                .await
                .is_err()
            {
                break;
            }
            match docs
                .handle_frame(&state, &live, peer_id, &user_id, capability, &frame)
                .await
            {
                Ok(replies) => {
                    let mut delivered = true;
                    for reply in replies {
                        if live.send_to(peer_id, reply).await.is_err() {
                            delivered = false;
                            break;
                        }
                    }
                    if !delivered {
                        break;
                    }
                }
                Err(SyncError::SnapshotPublicationForbidden) => {
                    tracing::warn!(%share_id, "live document edit rejected");
                    break;
                }
                Err(error) => {
                    tracing::warn!(%error, %share_id, "live document frame rejected");
                    break;
                }
            }
        }
    };
    let revalidate = async {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.tick().await;
        loop {
            interval.tick().await;
            if resolve_connection_access(&state, &ticket, access_token.as_deref())
                .await
                .is_err()
            {
                break;
            }
        }
    };
    tokio::select! {
        _ = writer => {},
        _ = reader => {},
        _ = revalidate, if state.replica.shots.is_some() => {},
    }
    docs.leave(&live, peer_id).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sink.close()).await;
}
