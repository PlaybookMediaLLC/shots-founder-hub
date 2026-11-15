use crate::error::{Result, SubscriptionError};
use anlg_cloud_db::{Database, Principal};
use anlg_r2_storage::Storage;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde::{Serialize, de::DeserializeOwned};

fn database_error<T>(_: T) -> SubscriptionError {
    SubscriptionError::Database("account database request failed".into())
}

#[derive(Clone)]
pub struct AccountStore {
    database: Database,
    storage: Storage,
}

impl AccountStore {
    pub fn new(database: Database, storage: Storage) -> Self {
        Self { database, storage }
    }

    pub(crate) async fn delete_file(
        &self,
        bucket: &str,
        key: &str,
    ) -> std::result::Result<(), anlg_r2_storage::Error> {
        self.storage
            .delete_catalog_file(&self.database, bucket, key)
            .await
    }

    pub(crate) async fn clear_prefix_until(
        &self,
        bucket: &str,
        prefix: &str,
        limit: usize,
        cancelled: impl Fn() -> bool,
    ) -> std::result::Result<usize, anlg_r2_storage::Error> {
        let count = self
            .storage
            .clear_prefix_until(bucket, prefix, limit, &cancelled)
            .await?;
        if cancelled() {
            return Err(anlg_r2_storage::Error::Cancelled);
        }
        let tx = self
            .database
            .transaction(&Principal::Service)
            .await
            .map_err(|_| anlg_r2_storage::Error::Api("catalog cleanup"))?;
        tx.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM founder_hub_files.objects WHERE bucket_id=$1 AND starts_with(name,$2)",
            [bucket.into(), prefix.into()],
        ))
        .await
        .map_err(|_| anlg_r2_storage::Error::Api("catalog cleanup"))?;
        tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "UPDATE founder_hub_private.file_uploads SET status='aborted' WHERE bucket=$1 AND starts_with(object_key,$2)", [bucket.into(), prefix.into()]))
            .await.map_err(|_| anlg_r2_storage::Error::Api("catalog cleanup"))?;
        tx.commit()
            .await
            .map_err(|_| anlg_r2_storage::Error::Api("catalog cleanup"))?;
        Ok(count)
    }

    pub(crate) async fn admin_rpc<
        RequestBody: Serialize + ?Sized,
        ResponseBody: DeserializeOwned,
    >(
        &self,
        function: &str,
        body: &RequestBody,
    ) -> Result<ResponseBody> {
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.database
                .rpc_bounded(&Principal::Service, function, body, 256 * 1024),
        )
        .await
        .map_err(database_error)?
        .map_err(database_error)
    }
}
