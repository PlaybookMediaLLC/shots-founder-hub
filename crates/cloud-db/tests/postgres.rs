use cloud_db::{Database, Error, Principal, entities::transcription_job, migrations};
use sea_orm::{ActiveModelTrait, ConnectionTrait, DbBackend, EntityTrait, Set, Statement};
use serde_json::{Value, json};
use uuid::Uuid;

#[tokio::test]
async fn postgres_migrations_orm_and_transaction_identity() {
    let database = Database::new(&std::env::var("CLOUD_DATABASE_TEST_URL").unwrap()).unwrap();
    migrations::migrate(&database).await.unwrap();
    migrations::migrate(&database).await.unwrap();
    database.connection().await.unwrap().execute_unprepared(
        "SET ROLE cloud_owner;
         CREATE OR REPLACE FUNCTION founder_hub.cloud_db_test_echo(p_value jsonb, p_suffix text DEFAULT 'default')
         RETURNS jsonb LANGUAGE sql AS 'SELECT p_value || jsonb_build_object(''suffix'', p_suffix)';
         CREATE OR REPLACE FUNCTION founder_hub.cloud_db_test_conflict() RETURNS void LANGUAGE plpgsql AS
         'BEGIN RAISE EXCEPTION ''sensitive row contents'' USING ERRCODE = ''40001''; END';
         CREATE OR REPLACE FUNCTION founder_hub.cloud_db_test_table() RETURNS TABLE(content jsonb)
         LANGUAGE sql AS 'SELECT jsonb_build_object(''id'', 1)';
         CREATE OR REPLACE FUNCTION founder_hub.cloud_db_test_set() RETURNS SETOF jsonb
         LANGUAGE sql AS 'SELECT jsonb_build_object(''id'', 1)';
         RESET ROLE;"
    ).await.unwrap();
    let user_id = Uuid::new_v4();
    let now = chrono::Utc::now().to_rfc3339();
    let snapshot = json!({
        "emailVerified": true, "revision": "1", "createdAt": now,
        "user": { "id": user_id.to_string(), "email": format!("{user_id}@example.test"), "name": "Test", "image": null },
        "accountUserId": user_id, "sessionId": "test-session", "expiresAt": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(), "workspaces": []
    });
    let _: Value = database
        .rpc(
            &Principal::Service,
            "project_shots_authority",
            &json!({ "p_snapshot": snapshot }),
        )
        .await
        .unwrap();
    let principal = Principal::User {
        user_id,
        session_id: "test-session".into(),
        revision: "1".into(),
        email: "cloud-db@example.test".into(),
        entitlements: vec![],
    };
    let value: Value = database
        .rpc(
            &principal,
            "cloud_db_test_echo",
            &json!({ "p_value": { "quoted": "'\\; DROP TABLE profiles;" } }),
        )
        .await
        .unwrap();
    assert_eq!(
        value,
        json!({ "quoted": "'\\; DROP TABLE profiles;", "suffix": "default" })
    );
    for (function, expected) in [
        ("cloud_db_test_table", json!([{ "content": { "id": 1 } }])),
        ("cloud_db_test_set", json!([{ "id": 1 }])),
    ] {
        let result: Value = database
            .rpc(&principal, function, &json!({}))
            .await
            .unwrap();
        assert_eq!(result, expected, "{function}");
    }
    let error = database
        .rpc::<Value>(&principal, "cloud_db_test_conflict", &json!({}))
        .await
        .unwrap_err();
    assert!(matches!(&error, Error::Database { code, .. } if code == "40001"));
    assert!(!error.to_string().contains("sensitive"));
    assert!(
        database
            .rpc::<Value>(
                &principal,
                "project_shots_authority",
                &json!({"p_snapshot": snapshot})
            )
            .await
            .is_err()
    );
    assert!(
        database
            .rpc::<Value>(&principal, "cloud_db_test_echo; SELECT 1", &json!({}))
            .await
            .is_err()
    );
    let id = Uuid::new_v4();
    let tx = database.transaction(&Principal::Service).await.unwrap();
    transcription_job::ActiveModel {
        id: Set(id),
        user_id: Set(user_id),
        file_id: Set("audio.m4a".into()),
        provider: Set("test".into()),
        status: Set("processing".into()),
        ..Default::default()
    }
    .insert(&tx)
    .await
    .unwrap();
    assert!(
        transcription_job::Entity::find_by_id(id)
            .one(&tx)
            .await
            .unwrap()
            .is_some()
    );
    tx.commit().await.unwrap();
    let tx = database.transaction(&principal).await.unwrap();
    assert!(
        transcription_job::Entity::find_by_id(id)
            .one(&tx)
            .await
            .unwrap()
            .is_some()
    );
    tx.rollback().await.unwrap();
    let other = Principal::User {
        user_id: Uuid::nil(),
        session_id: "other".into(),
        revision: "1".into(),
        email: "other@example.test".into(),
        entitlements: vec![],
    };
    let tx = database.transaction(&other).await.unwrap();
    assert!(
        transcription_job::Entity::find_by_id(id)
            .one(&tx)
            .await
            .unwrap()
            .is_none()
    );
    tx.rollback().await.unwrap();
    let tx = database.transaction(&Principal::Anonymous).await.unwrap();
    let row = tx
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT founder_hub_identity.user_id()::text AS id, current_user::text AS role"
                .to_owned(),
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<Option<String>>("", "id").unwrap(), None);
    assert_eq!(
        row.try_get::<String>("", "role").unwrap(),
        "cloud_anonymous"
    );
    tx.commit().await.unwrap();
}
