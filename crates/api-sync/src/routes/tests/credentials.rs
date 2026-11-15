use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::test_support::*;

const DEVICE: &str = "device-fingerprint-1";
const MEETING: &str = "meeting-key-0123456789";

#[tokio::test]
async fn pro_gated_sync_routes_reject_free_accounts() {
    let state = state();
    let mut auth = account(&state.config.database).await;
    auth.claims.entitlements.clear();
    let personal_workspace = auth.claims.sub.clone();
    let app = router(state, auth);
    for (method, path, body) in [
        ("POST", "/token".to_string(), Value::Null),
        ("GET", "/devices".to_string(), Value::Null),
        (
            "PATCH",
            format!("/devices/{DEVICE}"),
            json!({"deviceName":"Mac"}),
        ),
        ("DELETE", format!("/devices/{DEVICE}"), Value::Null),
        (
            "POST",
            format!("/meetings/{MEETING}/devices"),
            json!({"intent":"present"}),
        ),
        (
            "GET",
            format!("/e2ee/workspaces/{personal_workspace}/recipients"),
            Value::Null,
        ),
    ] {
        assert_eq!(
            request(&app, method, &path, body, None).await.0,
            StatusCode::FORBIDDEN,
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn device_and_meeting_inputs_are_validated() {
    let state = state();
    let app = router(state.clone(), account(&state.config.database).await);
    // Assert the message: a missing fingerprint header also returns 400.
    for (method, path, body, message) in [
        (
            "PATCH",
            format!("/devices/{DEVICE}"),
            json!({"deviceName":"   "}),
            "Sync device name must be between 1 and 128 bytes",
        ),
        (
            "PATCH",
            "/devices/bad!".to_string(),
            json!({"deviceName":"Mac"}),
            "Sync device identity is invalid",
        ),
        (
            "POST",
            "/meetings/short/devices".to_string(),
            json!({"intent":"present"}),
            "Invalid meeting key",
        ),
    ] {
        let (status, body) = request(&app, method, &path, body, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {path}");
        assert_eq!(body["error"]["message"], message, "{method} {path}");
    }
}

#[tokio::test]
async fn workspace_key_recipients_stay_inside_the_workspace() {
    let state = state();
    let owner = account(&state.config.database).await;
    let workspace = owner.shots.as_ref().unwrap().workspaces[0].workspace_id;
    let path = format!("/e2ee/workspaces/{workspace}/recipients");
    let recipients = ok(
        &router(state.clone(), owner),
        "GET",
        &path,
        Value::Null,
        None,
    )
    .await;
    assert!(recipients.is_array());

    let outsider = router(state.clone(), account(&state.config.database).await);
    let (status, body) = request(&outsider, "GET", &path, Value::Null, None).await;
    assert!(!status.is_success(), "outsider read recipients: {body}");
}
