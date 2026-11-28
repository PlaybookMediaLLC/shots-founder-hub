use sea_orm::{ConnectionTrait, DbBackend, Statement, TransactionTrait};
use sha2::{Digest, Sha256};

use crate::{Database, Error};

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

pub async fn migrate(database: &Database) -> Result<(), Error> {
    apply(database, MIGRATIONS).await
}

pub async fn apply(database: &Database, migrations: &[(&str, &str)]) -> Result<(), Error> {
    let connection = database.connection().await?;
    let tx = connection.begin().await?;
    tx.execute_unprepared("SELECT pg_advisory_xact_lock(716268349104); CREATE SCHEMA IF NOT EXISTS cloud_migrations; CREATE TABLE IF NOT EXISTS cloud_migrations.applied (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())").await?;
    tx.commit().await?;
    for (name, sql) in migrations {
        // PostgreSQL enum additions must commit before later migrations use them.
        let tx = connection.begin().await?;
        tx.execute_unprepared("SELECT pg_advisory_xact_lock(716268349104)")
            .await?;
        let checksum = Sha256::digest(sql.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let applied = tx
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT sha256 FROM cloud_migrations.applied WHERE name=$1",
                [(*name).into()],
            ))
            .await?;
        if let Some(applied) = applied {
            if applied.try_get::<String>("", "sha256")? != checksum {
                return Err(Error::InvalidOperation);
            }
            tx.commit().await?;
            continue;
        }
        if *name != "bootstrap.sql" {
            tx.execute_unprepared(
                "SET LOCAL ROLE cloud_owner; SET LOCAL search_path = founder_hub, extensions",
            )
            .await?;
        }
        tx.execute_unprepared(sql).await?;
        tx.execute_unprepared("RESET ROLE").await?;
        tx.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO cloud_migrations.applied(name, sha256) VALUES($1,$2)",
            [(*name).into(), checksum.into()],
        ))
        .await?;
        tx.commit().await?;
    }
    Ok(())
}
