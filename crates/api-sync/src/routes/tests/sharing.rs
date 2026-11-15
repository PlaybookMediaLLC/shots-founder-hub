use std::time::Duration;

use anlg_api_auth::{AuthContext, ShotsAuth, ShotsAuthority};
use anlg_cloud_db::Principal;
use axum::{Extension, Router, http::StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message as Frame;
use uuid::Uuid;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path},
};
use yrs::{
    Doc, GetString, ReadTxn, Text, Transact, Update,
    sync::{Message, SyncMessage},
    updates::{decoder::Decode, encoder::Encode},
};

use crate::{AppState, live_docs::encode_hex, test_support::*};

#[tokio::test]
async fn replica_acceptance_replays_receipts_and_reports_stale_bases_without_leaking_tenants() {
    let state = state();
    let auth = account(&state.config.database).await;
    let endpoint = format!("/e2ee/witness/{}/accepted", auth.claims.sub);
    let payload = json!({"version":1,"key_id":"abcdefghijklmnopqrstuv","nonce":"A".repeat(32),"ciphertext":"opaque"}).to_string();
    let body = json!({"mutationId":Uuid::new_v4(),"baseSequence":0,"initialize":false,"events":[{
        "recordId":"r".repeat(43),"payloadHash":URL_SAFE_NO_PAD.encode(Sha256::digest(payload.as_bytes())),"payload":payload
    }]});
    let receipt = ok(
        &router(state.clone(), auth.clone()),
        "POST",
        &endpoint,
        body.clone(),
        None,
    )
    .await;
    // A second instance bypasses the local admission timer and exercises database idempotency.
    let app = router(AppState::new(state.config.clone()), auth.clone());
    assert_eq!(
        ok(&app, "POST", &endpoint, body.clone(), None).await,
        receipt
    );
    let mut stale = body;
    stale["mutationId"] = json!(Uuid::new_v4());
    let app = router(AppState::new(state.config.clone()), auth);
    assert_eq!(
        request(&app, "POST", &endpoint, stale, None).await.0,
        StatusCode::CONFLICT
    );
    let page = ok(&app, "GET", &endpoint, Value::Null, None).await;
    assert_eq!(page["headSequence"], receipt["headSequence"]);
    assert_eq!(page["events"].as_array().unwrap().len(), 1);
    let other = router(state.clone(), account(&state.config.database).await);
    assert_eq!(
        request(&other, "GET", &endpoint, Value::Null, None).await.0,
        StatusCode::FORBIDDEN
    );
}

async fn live_fixture() -> (AppState, AuthContext, String, MockServer) {
    let state = state();
    let auth = account(&state.config.database).await;
    let session = auth.shots.as_ref().unwrap();
    let share = Uuid::new_v4();
    let tx = state
        .config
        .database
        .transaction(&Principal::Service)
        .await
        .unwrap();
    tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO founder_hub.session_shares(id,workspace_id,session_id,created_by_user_id,general_scope) VALUES($1,$2,$3,$4,'restricted')",
        [share.into(), session.workspaces[0].workspace_id.into(), share.to_string().into(), session.account_user_id.into()]
    )).await.unwrap();
    tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO founder_hub.session_share_snapshots(share_id,content_revision,title,body_json,published_by_user_id,web_editable) VALUES($1,1,'Live test',$2,$3,true)",
        [share.into(), json!({"type":"doc","content":[{"type":"paragraph"}]}).into(), session.account_user_id.into()]
    )).await.unwrap();
    tx.commit().await.unwrap();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/founder-hub/session"))
        .and(header("authorization", "Bearer opaque-test-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(session))
        .mount(&server)
        .await;
    let shots = ShotsAuth::new(
        &server.uri(),
        "test-service-token-at-least-thirty-two-bytes",
    )
    .unwrap()
    .with_authority(ShotsAuthority::new(state.config.database.clone()));
    (
        state.with_shots(Some(shots)),
        auth,
        share.to_string(),
        server,
    )
}

fn live_router(state: AppState, auth: AuthContext) -> Router {
    crate::web_edit_router(state.clone())
        .merge(crate::live_socket_router(state))
        .layer(Extension(auth))
}

async fn ticket(app: &Router, share: &str) -> String {
    let result = ok(
        app,
        "POST",
        &format!("/shares/{share}/live/ticket"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(result["requiresAuth"], true);
    result["ticket"].as_str().unwrap().to_owned()
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(app: Router, share: &str, ticket: &str) -> (Socket, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://{address}/shares/{share}/live?ticket={ticket}"
    ))
    .await
    .unwrap();
    (socket, server)
}

async fn next(socket: &mut Socket) -> Frame {
    tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("frame deadline")
        .expect("open socket")
        .expect("valid frame")
}

async fn handshake(socket: &mut Socket, doc: &Doc) {
    socket
        .send(Frame::Text(
            json!({"accessToken":"opaque-test-token"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let Frame::Text(ready) = next(socket).await else {
        panic!("missing ready")
    };
    assert_eq!(
        serde_json::from_str::<Value>(&ready).unwrap()["type"],
        "ready"
    );
    let Frame::Binary(step1) = next(socket).await else {
        panic!("missing step1")
    };
    assert!(matches!(
        Message::decode_v1(&step1).unwrap(),
        Message::Sync(SyncMessage::SyncStep1(_))
    ));
    let Frame::Binary(step2) = next(socket).await else {
        panic!("missing step2")
    };
    let Message::Sync(SyncMessage::SyncStep2(update)) = Message::decode_v1(&step2).unwrap() else {
        panic!("invalid step2")
    };
    doc.transact_mut()
        .apply_update(Update::decode_v1(&update).unwrap())
        .unwrap();
}

fn update(doc: &Doc, text: &str) -> Vec<u8> {
    let field = doc.get_or_insert_text("body");
    let mut tx = doc.transact_mut();
    let before = tx.before_state().clone();
    field.push(&mut tx, text);
    drop(tx);
    doc.transact().encode_diff_v1(&before)
}

fn frame(update: Vec<u8>) -> Frame {
    Frame::Binary(
        Message::Sync(SyncMessage::Update(update))
            .encode_v1()
            .into(),
    )
}

async fn stored(state: &AppState, share: &str) -> Value {
    state
        .config
        .database
        .rpc(
            &Principal::Service,
            "read_session_share_live_document",
            &json!({"p_share_id":share}),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn live_edits_survive_restart_and_relay_between_instances() {
    let (state, auth, share, _authority) = live_fixture().await;
    let app = live_router(state.clone(), auth.clone());
    let grant = ticket(&app, &share).await;
    let (mut socket, server) = connect(app, &share, &grant).await;
    let doc = Doc::new();
    handshake(&mut socket, &doc).await;
    socket.send(frame(update(&doc, "persisted"))).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while stored(&state, &share).await[0]["updates"]
            .as_array()
            .unwrap()
            .is_empty()
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let mut restarted = AppState::new(state.config.clone());
    restarted.replica.shots = state.replica.shots.clone();
    let app = live_router(restarted, auth);
    let (mut peer, peer_server) = connect(app, &share, &grant).await;
    let restored = Doc::new();
    handshake(&mut peer, &restored).await;
    assert_eq!(
        restored
            .get_or_insert_text("body")
            .get_string(&restored.transact()),
        "persisted"
    );
    peer.send(frame(update(&restored, " and relayed")))
        .await
        .unwrap();
    let Frame::Binary(bytes) = next(&mut socket).await else {
        panic!("missing relayed edit")
    };
    let Message::Sync(SyncMessage::Update(update)) = Message::decode_v1(&bytes).unwrap() else {
        panic!("invalid update")
    };
    doc.transact_mut()
        .apply_update(Update::decode_v1(&update).unwrap())
        .unwrap();
    assert_eq!(
        doc.get_or_insert_text("body").get_string(&doc.transact()),
        "persisted and relayed"
    );
    socket.close(None).await.unwrap();
    peer.close(None).await.unwrap();
    server.abort();
    peer_server.abort();
}

#[tokio::test]
async fn revoked_or_unavailable_sessions_receive_no_live_content_and_cannot_save_edits() {
    for trigger in [
        "handshake",
        "write",
        "broadcast",
        "different_session",
        "unavailable",
    ] {
        let (state, auth, share, authority) = live_fixture().await;
        let app = live_router(state.clone(), auth.clone());
        let grant = ticket(&app, &share).await;
        let (mut socket, server) = connect(app, &share, &grant).await;
        let established = matches!(trigger, "write" | "broadcast" | "unavailable");
        if established {
            handshake(&mut socket, &Doc::new()).await;
        }
        let response = if trigger == "different_session" {
            let mut session = serde_json::to_value(auth.shots.as_ref().unwrap()).unwrap();
            session["sessionId"] = json!(Uuid::new_v4().to_string());
            ResponseTemplate::new(200).set_body_json(session)
        } else {
            ResponseTemplate::new(if trigger == "unavailable" { 503 } else { 401 })
        };
        Mock::given(method("GET"))
            .and(path("/api/founder-hub/session"))
            .respond_with(response)
            .with_priority(1)
            .mount(&authority)
            .await;
        if !established {
            socket
                .send(Frame::Text(
                    json!({"accessToken":"opaque-test-token"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        } else if trigger == "broadcast" {
            state.config.database.rpc::<Value>(&Principal::Service, "append_session_share_live_update", &json!({
                "p_share_id":share,"p_actor_user_id":auth.claims.sub,
                "p_update_hex":encode_hex(&update(&Doc::new(), "private")),"p_require_empty":true
            })).await.unwrap();
        } else {
            socket
                .send(frame(update(&Doc::new(), "revoked edit")))
                .await
                .unwrap();
        }
        let received = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("revoked socket closes");
        assert!(
            matches!(received, None | Some(Ok(Frame::Close(_)))),
            "{trigger} leaked content: {received:?}"
        );
        assert_eq!(
            stored(&state, &share).await[0]["updates"]
                .as_array()
                .unwrap()
                .len(),
            usize::from(trigger == "broadcast")
        );
        server.abort();
    }
}
