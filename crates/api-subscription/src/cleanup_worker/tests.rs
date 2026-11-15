use super::*;
use anlg_cloud_db::{Database, Principal};
use anlg_r2_storage::Storage;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::Value;

fn worker() -> (CleanupWorker, Database, Storage) {
    let database = Database::new(
        &std::env::var("CLOUD_DATABASE_TEST_URL").expect("isolated PostgreSQL required"),
    )
    .unwrap();
    let storage = Storage::new(
        &serde_json::from_str(
            &std::env::var("R2_TEST_CONFIG").expect("isolated S3 storage required"),
        )
        .unwrap(),
    )
    .unwrap();
    (
        CleanupWorker::for_shots(database.clone(), storage.clone()),
        database,
        storage,
    )
}
#[test]
fn full_batches_back_off_without_changing_idle_polling() {
    assert_eq!(full_batch_poll_delay(true), Some(Duration::from_secs(5)));
    assert_eq!(full_batch_poll_delay(false), None);
    assert_eq!(POLL_INTERVAL, Duration::from_secs(30));
}
#[test]
fn leases_reject_cross_owner_paths_expiry_and_unbounded_sizes() {
    let owner = Uuid::new_v4();
    let object = Uuid::new_v4();
    let lease = Uuid::now_v7().to_string();
    let mut row = AttachmentLeaseRow {
        object_id: object.to_string(),
        owner_user_id: owner.to_string(),
        object_key: format!("{owner}/{object}.anb1"),
        ciphertext_size_bytes: 4,
        gc_lease_id: lease.clone(),
        gc_lease_expires_at: (Utc::now() + TimeDelta::minutes(5)).to_rfc3339(),
    };
    assert!(validate_attachment_lease(&row, &lease).is_ok());
    row.object_key = format!("{}/{object}.anb1", Uuid::new_v4());
    assert!(validate_attachment_lease(&row, &lease).is_err());
    row.object_key = format!("{owner}/{object}.anb1");
    row.ciphertext_size_bytes = MAX_CIPHERTEXT_SIZE_BYTES + 1;
    assert!(validate_attachment_lease(&row, &lease).is_err());
    row.ciphertext_size_bytes = 4;
    row.gc_lease_expires_at = (Utc::now() - TimeDelta::seconds(1)).to_rfc3339();
    assert!(validate_attachment_lease(&row, &lease).is_err());
}
#[tokio::test]
async fn cancellation_stops_cleanup_before_claiming_work() {
    let (worker, _, _) = worker();
    let stop = CancellationToken::new();
    stop.cancel();
    assert_eq!(worker.run_attachment_batch(&stop).await.unwrap(), 0);
    assert_eq!(worker.run_shared_attachment_batch(&stop).await.unwrap(), 0);
    assert_eq!(worker.run_account_batch(&stop).await.unwrap(), 0);
}
#[tokio::test]
async fn shots_cleanup_aborts_orphan_uploads_removes_projection_and_prevents_resurrection() {
    let (worker, database, storage) = worker();
    let owner = Uuid::new_v4();
    database
        .connection()
        .await
        .unwrap()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO founder_hub_identity.users(id,email) VALUES($1,$2)",
            [owner.into(), format!("{owner}@example.test").into()],
        ))
        .await
        .unwrap();
    let key = format!("{owner}/orphan.wav");
    let upload = storage
        .begin_upload(AUDIO_BUCKET, &key, "audio/wav", &json!({}))
        .await
        .unwrap();
    let _: Value = database
        .rpc(
            &Principal::Service,
            "begin_account_deletion",
            &json!({"p_owner_user_id":owner}),
        )
        .await
        .unwrap();
    database.connection().await.unwrap().execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE founder_hub_private.account_deletion_jobs SET requested_at=now()-interval '2 days',final_sweep_not_before=now()-interval '1 day' WHERE owner_user_id=$1",[owner.into()])).await.unwrap();
    let lease = Uuid::now_v7().to_string();
    let rows: Vec<AccountLeaseRow> = worker
        .store
        .admin_rpc(
            "claim_account_deletion_leases_v2",
            &ClaimRequest {
                p_lease_id: lease.clone(),
                p_limit: 4,
                p_lease_seconds: 900,
            },
        )
        .await
        .unwrap();
    let row = rows
        .into_iter()
        .find(|row| row.owner_user_id == owner.to_string())
        .expect("account lease");
    validate_account_lease(&row, &lease).unwrap();
    worker
        .delete_account(row, &CancellationToken::new())
        .await
        .unwrap();
    assert!(
        storage
            .list_parts(AUDIO_BUCKET, &key, &upload)
            .await
            .is_err()
    );
    let row = database
        .connection()
        .await
        .unwrap()
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT EXISTS(SELECT 1 FROM founder_hub_identity.users WHERE id=$1) AS present",
            [owner.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert!(!row.try_get::<bool>("", "present").unwrap());
    assert!(
        database
            .connection()
            .await
            .unwrap()
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO founder_hub_identity.users(id) VALUES($1)",
                [owner.into()]
            ))
            .await
            .is_err()
    );
}
