use std::{sync::Arc, time::Duration};

use futures_util::TryStreamExt;
use sea_orm::StreamTrait;
use sea_orm::{
    ConnectOptions, ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, DbErr,
    Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::sync::OnceCell;

pub mod entities;
pub mod migrations;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database configuration is invalid")]
    Configuration,
    #[error("database operation failed ({code})")]
    Database {
        code: String,
        reason: Option<&'static str>,
    },
    #[error("invalid database operation")]
    InvalidOperation,
    #[error("database response did not match the expected contract")]
    InvalidResponse,
    #[error("database response exceeded the requested size limit")]
    ResponseTooLarge,
}

impl From<DbErr> for Error {
    fn from(error: DbErr) -> Self {
        // Database errors can include row contents; expose only the SQLSTATE.
        let database_error = match &error {
            DbErr::Exec(sea_orm::RuntimeErr::SqlxError(error))
            | DbErr::Query(sea_orm::RuntimeErr::SqlxError(error)) => error.as_database_error(),
            _ => None,
        };
        let code = database_error
            .and_then(|error| error.code())
            .map(|code| code.into_owned())
            .unwrap_or_else(|| "database_error".into());
        let reason = database_error.and_then(|error| match error.message() {
            "Shots snapshot permission required" => Some("permission_denied"),
            "hyprnote pro entitlement required" => Some("subscription_required"),
            "cloud API not enabled" => Some("cloud_api_not_enabled"),
            value if value.starts_with("invalid cloud API") => Some("invalid_cloud_api_request"),
            _ => None,
        });
        Self::Database { code, reason }
    }
}

#[derive(Clone)]
pub struct Database {
    url: Arc<str>,
    connection: Arc<OnceCell<DatabaseConnection>>,
}

#[derive(Clone, Debug)]
pub enum Principal {
    Service,
    Anonymous,
    User {
        user_id: uuid::Uuid,
        session_id: String,
        revision: String,
        email: String,
        entitlements: Vec<String>,
    },
}

impl Principal {
    fn role(&self) -> &'static str {
        match self {
            Self::Service => "cloud_service",
            Self::Anonymous => "cloud_anonymous",
            Self::User { .. } => "cloud_member",
        }
    }

    fn claims(&self) -> Value {
        match self {
            Self::User {
                user_id,
                session_id,
                revision,
                email,
                entitlements,
            } => json!({
                "sub": user_id, "role": "cloud_member", "email": email,
                "shots_session_id": session_id, "shots_revision": revision,
                "entitlements": entitlements, "app_metadata": { "provider": "shots" },
            }),
            _ => json!({ "role": self.role() }),
        }
    }
}

#[derive(Deserialize)]
struct Function {
    names: Vec<String>,
    types: Vec<String>,
    required: usize,
    set: bool,
    table: bool,
}

impl Database {
    pub fn new(url: &str) -> Result<Self, Error> {
        if !(url.starts_with("postgres://") || url.starts_with("postgresql://")) {
            return Err(Error::Configuration);
        }
        Ok(Self {
            url: url.into(),
            connection: Arc::default(),
        })
    }

    pub async fn connection(&self) -> Result<&DatabaseConnection, Error> {
        self.connection
            .get_or_try_init(|| async {
                let mut options = ConnectOptions::new(self.url.to_string());
                options
                    .max_connections(20)
                    .min_connections(0)
                    .connect_timeout(Duration::from_secs(10))
                    .acquire_timeout(Duration::from_secs(10))
                    .idle_timeout(Duration::from_secs(300))
                    .sqlx_logging(false);
                sea_orm::Database::connect(options)
                    .await
                    .map_err(Error::from)
            })
            .await
    }

    pub async fn transaction(&self, principal: &Principal) -> Result<DatabaseTransaction, Error> {
        let tx = self.connection().await?.begin().await?;
        tx.execute_unprepared(&format!("SET LOCAL ROLE {}; SET LOCAL search_path = founder_hub, extensions; SET LOCAL statement_timeout = '30s'", principal.role())).await?;
        tx.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT set_config('request.identity', $1, true)",
            [principal.claims().to_string().into()],
        ))
        .await?;
        if matches!(principal, Principal::User { .. }) {
            tx.execute_unprepared("SELECT founder_hub.check_shots_request()")
                .await?;
        }
        Ok(tx)
    }

    pub async fn rpc<T: DeserializeOwned>(
        &self,
        principal: &Principal,
        function: &str,
        body: &(impl Serialize + ?Sized),
    ) -> Result<T, Error> {
        self.rpc_bounded(principal, function, body, 64 * 1024 * 1024)
            .await
    }

    pub async fn rpc_bounded<T: DeserializeOwned>(
        &self,
        principal: &Principal,
        function: &str,
        body: &(impl Serialize + ?Sized),
        max_bytes: usize,
    ) -> Result<T, Error> {
        let body = serde_json::to_value(body).map_err(|_| Error::InvalidOperation)?;
        let body = body.as_object().ok_or(Error::InvalidOperation)?;
        if !identifier(function) || body.keys().any(|key| !identifier(key)) {
            return Err(Error::InvalidOperation);
        }
        let tx = self.transaction(principal).await?;
        let candidates = tx.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT jsonb_build_object('names', coalesce(p.proargnames[1:p.pronargs], ARRAY[]::text[]), 'types', ARRAY(SELECT pg_catalog.format_type(t, NULL) FROM unnest(p.proargtypes::oid[]) t), 'required', p.pronargs - p.pronargdefaults, 'set', p.proretset, 'table', coalesce('t' = ANY(p.proargmodes), false)) AS value FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='founder_hub' AND p.proname=$1 AND p.prokind='f' AND has_function_privilege(p.oid,'EXECUTE')",
            [function.into()],
        )).await?;
        let candidates: Vec<Function> = candidates
            .into_iter()
            .filter_map(|row| {
                let value: Value = row.try_get("", "value").ok()?;
                serde_json::from_value(value).ok()
            })
            .filter(|candidate: &Function| {
                candidate.names.len() == candidate.types.len()
                    && body.keys().all(|name| candidate.names.contains(name))
                    && candidate
                        .names
                        .iter()
                        .take(candidate.required)
                        .all(|name| body.contains_key(name))
            })
            .collect();
        let [signature] = candidates.as_slice() else {
            return Err(Error::InvalidOperation);
        };
        let arguments: Vec<_> = signature
            .names
            .iter()
            .zip(&signature.types)
            .filter(|(name, _)| body.contains_key(*name))
            .collect();
        let columns = arguments
            .iter()
            .map(|(name, kind)| format!("\"{name}\" {kind}"))
            .collect::<Vec<_>>()
            .join(", ");
        let parameters = arguments.iter().map(|(name, _)| {
            format!("\"{name}\" => (SELECT \"{name}\" FROM jsonb_to_record($1::jsonb) AS input({columns}))")
        }).collect::<Vec<_>>().join(", ");
        let call = format!("founder_hub.\"{function}\"({parameters})");
        let source = if signature.table {
            format!("(SELECT * FROM {call})")
        } else {
            call
        };
        let sql = format!("SELECT to_jsonb(result) AS value FROM {source} AS result");
        let values = if arguments.is_empty() {
            vec![]
        } else {
            vec![Value::Object(body.clone()).into()]
        };
        let mut rows = tx
            .stream_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                sql,
                values,
            ))
            .await?;
        let mut values = Vec::new();
        let mut size = 2_usize;
        while let Some(row) = rows.try_next().await? {
            let value: Value = row.try_get("", "value")?;
            size = size
                .saturating_add(value.to_string().len())
                .saturating_add(1);
            if size > max_bytes {
                return Err(Error::ResponseTooLarge);
            }
            values.push(value);
        }
        drop(rows);
        let value = if signature.set {
            Value::Array(values)
        } else {
            values.into_iter().next().unwrap_or(Value::Null)
        };
        let result = serde_json::from_value(value).map_err(|_| Error::InvalidResponse)?;
        tx.commit().await?;
        Ok(result)
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        && !value.as_bytes()[0].is_ascii_digit()
}
