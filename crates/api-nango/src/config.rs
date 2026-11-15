use anlg_api_env::NangoEnv;
use anlg_cloud_db::Database;
use anlg_nango::NangoClient;

#[derive(Clone)]
pub struct NangoConfig {
    pub nango: NangoEnv,
    pub database: Database,
}

impl NangoConfig {
    pub fn new(nango: &NangoEnv, database: Database) -> Self {
        Self {
            nango: nango.clone(),
            database,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(nango_base: &str) -> Self {
        Self {
            nango: NangoEnv {
                nango_api_base: Some(nango_base.to_string()),
                nango_api_key: "test-api-key".into(),
                nango_webhook_signing_key: "test-webhook-signing-key".into(),
            },
            database: Database::new(
                &std::env::var("CLOUD_DATABASE_TEST_URL")
                    .unwrap_or_else(|_| "postgres://localhost/unavailable_test_database".into()),
            )
            .unwrap(),
        }
    }
}

pub(crate) fn build_nango_client(config: &NangoConfig) -> Result<NangoClient, anlg_nango::Error> {
    let mut builder = anlg_nango::NangoClient::builder().api_key(&config.nango.nango_api_key);
    if let Some(api_base) = &config.nango.nango_api_base {
        builder = builder.api_base(api_base);
    }

    builder.build()
}

#[cfg(test)]
pub(crate) async fn test_user(database: &Database) -> uuid::Uuid {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    let id = uuid::Uuid::new_v4();
    database
        .connection()
        .await
        .unwrap()
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO founder_hub_identity.users(id,email) VALUES($1,$2)",
            [id.into(), format!("{id}@example.test").into()],
        ))
        .await
        .unwrap();
    id
}

#[cfg(test)]
pub(crate) async fn test_drive_auth(
    database: &Database,
    owned: bool,
) -> anlg_api_auth::AuthContext {
    use anlg_cloud_db::Principal;
    use serde_json::{Value, json};
    // Read-only Drive fixtures share one connection; unowned requests use a different account.
    let id = if owned {
        uuid::Uuid::parse_str("c96be642-a216-47b2-a220-653398754d15").unwrap()
    } else {
        uuid::Uuid::new_v4()
    };
    let snapshot = json!({"emailVerified":true,"revision":"1","createdAt":"2026-01-01T00:00:00Z",
        "user":{"id":id,"email":format!("{id}@example.test"),"name":"Drive test","image":null},
        "accountUserId":id,"sessionId":uuid::Uuid::new_v4().to_string(),
        "expiresAt":chrono::Utc::now()+chrono::Duration::hours(1),"workspaces":[]});
    database
        .rpc::<Value>(
            &Principal::Service,
            "project_shots_authority",
            &json!({"p_snapshot":snapshot}),
        )
        .await
        .unwrap();
    if owned {
        crate::store::ConnectionStore::new(database.clone())
            .upsert_connection(
                &id.to_string(),
                "google-drive",
                "connection",
                "google-drive",
            )
            .await
            .unwrap();
    }
    let shots: anlg_api_auth::ShotsSession = serde_json::from_value(snapshot).unwrap();
    anlg_api_auth::AuthContext {
        claims: shots.claims(),
        shots: Some(shots),
        token: "opaque-drive-test-token".into(),
    }
}
