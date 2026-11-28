use crate::{Error, Storage};
use anlg_cloud_db::{Database, Principal, entities::file_upload};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, IntoActiveModel,
    QueryFilter, QuerySelect, Set, Statement,
};

fn catalog_error(_: impl std::fmt::Display) -> Error {
    Error::Api("catalog cleanup")
}

impl Storage {
    pub async fn delete_catalog_file(
        &self,
        database: &Database,
        bucket: &str,
        key: &str,
    ) -> Result<(), Error> {
        let tx = database
            .transaction(&Principal::Service)
            .await
            .map_err(catalog_error)?;
        tx.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [format!("{bucket}/{key}").into()],
        ))
        .await
        .map_err(catalog_error)?;
        let upload = file_upload::Entity::find()
            .filter(file_upload::Column::Bucket.eq(bucket))
            .filter(file_upload::Column::ObjectKey.eq(key))
            .lock_exclusive()
            .one(&tx)
            .await
            .map_err(catalog_error)?;
        if let Some(row) = upload {
            if row.status == "active" {
                self.abort_upload(bucket, key, &row.upload_id).await?;
            }
            let mut row = row.into_active_model();
            row.status = Set("aborted".into());
            row.update(&tx).await.map_err(catalog_error)?;
        }
        self.delete_file(bucket, key).await?;
        tx.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM founder_hub_files.objects WHERE bucket_id=$1 AND name=$2",
            [bucket.into(), key.into()],
        ))
        .await
        .map_err(catalog_error)?;
        tx.commit().await.map_err(catalog_error)
    }
}
