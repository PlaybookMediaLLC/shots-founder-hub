mod credentials;
mod sharing;

use crate::test_support::*;
use axum::http::StatusCode;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[tokio::test]
async fn multipart_capabilities_resume_rotate_and_cannot_resurrect_deleted_files() {
    let state = state();
    let auth = account(&state.config.database).await;
    let owner = auth.claims.sub.clone();
    let app = router(state.clone(), auth);
    let key = format!("{owner}/{}.wav", Uuid::new_v4());
    let body = json!({"bucket":"audio-files","key":key,"size":4,"contentType":"audio/wav"});
    let grant = ok(&app, "POST", "/files/begin", body.clone(), None).await;
    let old_token = grant["token"].as_str().unwrap();
    let new_grant = ok(&app, "POST", "/files/begin", body, None).await;
    let token = new_grant["token"].as_str().unwrap();
    assert_ne!(old_token, token);
    assert_eq!(
        request(
            &app,
            "POST",
            "/files/uploads/status",
            json!({}),
            Some(old_token)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/files/uploads/part",
            json!({"number":2}),
            Some(token)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let part = ok(
        &app,
        "POST",
        "/files/uploads/part",
        json!({"number":1}),
        Some(token),
    )
    .await;
    let result = reqwest::Client::new()
        .put(part["url"].as_str().unwrap())
        .body("wave")
        .send()
        .await
        .unwrap();
    assert!(result.status().is_success());
    let status = ok(
        &app,
        "POST",
        "/files/uploads/status",
        json!({}),
        Some(token),
    )
    .await;
    assert_eq!(status["parts"][0]["size"], 4);
    ok(
        &app,
        "POST",
        "/files/uploads/complete",
        json!({}),
        Some(token),
    )
    .await;
    ok(
        &app,
        "POST",
        "/files/uploads/complete",
        json!({}),
        Some(token),
    )
    .await;
    let signed = ok(
        &app,
        "POST",
        "/files/download",
        json!({"bucket":"audio-files","key":key}),
        None,
    )
    .await;
    assert_eq!(
        reqwest::get(signed["signedUrl"].as_str().unwrap())
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
        "wave"
    );
    let other = router(state.clone(), account(&state.config.database).await);
    assert_eq!(
        request(
            &other,
            "POST",
            "/files/remove",
            json!({"bucket":"audio-files","key":key}),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    ok(
        &app,
        "POST",
        "/files/remove",
        json!({"bucket":"audio-files","key":key}),
        None,
    )
    .await;
    assert_eq!(
        request(
            &app,
            "POST",
            "/files/uploads/complete",
            json!({}),
            Some(token)
        )
        .await
        .0,
        StatusCode::GONE
    );
    assert!(
        state
            .storage
            .object_metadata("audio-files", &key)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn abort_expiry_and_account_deletion_revoke_upload_capabilities() {
    let state = state();
    let auth = account(&state.config.database).await;
    let owner = auth.claims.sub.clone();
    let app = router(state.clone(), auth);
    for mode in ["abort", "expire", "delete"] {
        let key = format!("{owner}/{mode}.wav");
        let body = json!({"bucket":"audio-files","key":key,"size":4,"contentType":"audio/wav"});
        let grant = ok(&app, "POST", "/files/begin", body, None).await;
        let token = grant["token"].as_str().unwrap();
        if mode == "abort" {
            ok(&app, "POST", "/files/uploads/abort", json!({}), Some(token)).await;
        } else {
            let tx = state.config.database.connection().await.unwrap();
            let sql = if mode == "expire" {
                "UPDATE founder_hub_private.file_uploads SET expires_at=now()-interval '1 second' WHERE object_key=$1"
            } else {
                "INSERT INTO founder_hub_private.deleted_accounts(user_id) VALUES($1::uuid)"
            };
            let value = if mode == "expire" { &key } else { &owner };
            tx.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                sql,
                [value.clone().into()],
            ))
            .await
            .unwrap();
        }
        assert_eq!(
            request(
                &app,
                "POST",
                "/files/uploads/part",
                json!({"number":1}),
                Some(token)
            )
            .await
            .0,
            StatusCode::GONE
        );
        state
            .storage
            .delete_catalog_file(&state.config.database, "audio-files", &key)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn backup_round_trip_checks_bytes_and_preserves_immutable_identity() {
    let state = state();
    let auth = account(&state.config.database).await;
    let other_auth = account(&state.config.database).await;
    let app = router(state.clone(), auth);
    let other = router(state.clone(), other_auth);
    let bytes = b"encrypted backup";
    let digest = Sha256::digest(bytes)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect::<String>();
    let attachment = "A".repeat(43);
    let version = "B".repeat(43);
    let reservation = json!({"attachmentRef":attachment,"versionRef":version,"ciphertextSizeBytes":bytes.len(),"formatVersion":1});
    let reserved = ok(
        &app,
        "POST",
        "/attachment-backups/reserve",
        reservation.clone(),
        None,
    )
    .await;
    let replay = ok(
        &app,
        "POST",
        "/attachment-backups/reserve",
        reservation,
        None,
    )
    .await;
    assert_eq!(replay["objectKey"], reserved["objectKey"]);
    let key = reserved["objectKey"].as_str().unwrap();
    let wrong = request(
        &other,
        "POST",
        "/attachment-backups/upload-grant",
        json!({"objectKey":key,"ciphertextSha256":digest}),
        None,
    )
    .await;
    assert!(!wrong.0.is_success());
    let grant = ok(
        &app,
        "POST",
        "/attachment-backups/upload-grant",
        json!({"objectKey":key,"ciphertextSha256":digest}),
        None,
    )
    .await;
    let token = grant["uploadToken"].as_str().unwrap();
    let part = ok(
        &app,
        "POST",
        "/files/uploads/part",
        json!({"number":1}),
        Some(token),
    )
    .await;
    assert!(
        reqwest::Client::new()
            .put(part["url"].as_str().unwrap())
            .body(bytes.to_vec())
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    ok(
        &app,
        "POST",
        "/files/uploads/complete",
        json!({}),
        Some(token),
    )
    .await;
    ok(
        &app,
        "POST",
        "/attachment-backups/finalize",
        json!({"objectKey":key}),
        None,
    )
    .await;
    ok(
        &app,
        "PUT",
        "/attachment-backups/head",
        json!({"objectKey":key,"expectedCurrentObjectKey":null}),
        None,
    )
    .await;
    let download = ok(
        &app,
        "POST",
        "/attachment-backups/download",
        json!({"objectKey":key}),
        None,
    )
    .await;
    assert_eq!(download["ciphertextSha256"], digest);
    assert_eq!(
        &reqwest::get(download["signedUrl"].as_str().unwrap())
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap()[..],
        bytes
    );
    let conflict = request(
        &app,
        "POST",
        "/attachment-backups/upload-grant",
        json!({"objectKey":key,"ciphertextSha256":"f".repeat(64)}),
        None,
    )
    .await;
    assert_eq!(conflict.0, StatusCode::CONFLICT);
    let deleted = ok(&app,"POST","/attachment-backups/delete",json!({"objectKey":key,"attachmentRef":attachment,"versionRef":version,"deleteRequestId":Uuid::new_v4()}),None).await;
    assert_eq!(deleted["objectKey"], key);
    state
        .storage
        .delete_catalog_file(&state.config.database, "attachment-backups", key)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/files/uploads/complete",
            json!({}),
            Some(token)
        )
        .await
        .0,
        StatusCode::GONE
    );
}

#[tokio::test]
async fn invalid_uploads_and_unpaid_backups_fail_before_storage() {
    let state = state();
    let mut auth = account(&state.config.database).await;
    let key = format!("{}/bad.wav", auth.claims.sub);
    auth.claims.entitlements.clear();
    let app = router(state, auth);
    assert_eq!(request(&app,"POST","/attachment-backups/reserve",json!({"attachmentRef":"A".repeat(43),"versionRef":"B".repeat(43),"ciphertextSizeBytes":4,"formatVersion":1}),None).await.0,StatusCode::FORBIDDEN);
    for (bucket, size) in [
        ("unknown", 4),
        ("audio-files", 0),
        ("audio-files", u64::MAX),
    ] {
        assert_eq!(
            request(
                &app,
                "POST",
                "/files/begin",
                json!({"bucket":bucket,"key":key,"size":size,"contentType":"audio/wav"}),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(
            &app,
            "POST",
            "/files/uploads/status",
            json!({}),
            Some("bad")
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

#[test]
fn witness_admission_is_bounded_and_releases_slots_after_cancellation() {
    let writes = crate::state::WitnessWrites::default();
    let permits = (0..4)
        .map(|i| writes.try_acquire(&i.to_string()).unwrap())
        .collect::<Vec<_>>();
    assert!(writes.try_acquire("fifth").is_none());
    assert!(writes.try_acquire("0").is_none());
    drop(permits);
    assert!(writes.try_acquire("new").is_some());
    assert!(writes.try_acquire("0").is_none());
}
