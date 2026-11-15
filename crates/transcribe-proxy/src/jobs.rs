use anlg_cloud_db::{Database, Principal, entities::transcription_job as job};
use anlg_r2_storage::Storage;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Database(#[from] anlg_cloud_db::Error),
    #[error("invalid transcription job")]
    InvalidJob,
}

impl From<sea_orm::DbErr> for Error {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Database(error.into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PipelineStatus {
    Processing,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionJob {
    pub id: String,
    pub user_id: String,
    pub file_id: String,
    pub provider: String,
    pub status: PipelineStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JobUpdate {
    pub status: PipelineStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct JobStore {
    database: Database,
    storage: Storage,
}

impl JobStore {
    pub fn new(database: Database, storage: Storage) -> Self {
        Self { database, storage }
    }

    pub fn storage(&self) -> Storage {
        self.storage.clone()
    }

    pub async fn delete_audio(&self, key: &str) -> Result<(), anlg_r2_storage::Error> {
        self.storage
            .delete_catalog_file(&self.database, "audio-files", key)
            .await
    }

    pub async fn insert_job(&self, value: &TranscriptionJob) -> Result<(), Error> {
        let tx = self.database.transaction(&Principal::Service).await?;
        job::ActiveModel {
            id: Set(parse_id(&value.id)?),
            user_id: Set(parse_id(&value.user_id)?),
            file_id: Set(value.file_id.clone()),
            provider: Set(value.provider.clone()),
            status: Set(value.status.as_str().into()),
            provider_request_id: Set(value.provider_request_id.clone()),
            raw_result: Set(value.raw_result.clone()),
            error: Set(value.error.clone()),
            ..Default::default()
        }
        .insert(&tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn update_job(&self, id: &str, updates: &JobUpdate) -> Result<(), Error> {
        let tx = self.database.transaction(&Principal::Service).await?;
        let mut model = job::ActiveModel {
            id: Set(parse_id(id)?),
            status: Set(updates.status.as_str().into()),
            ..Default::default()
        };
        if let Some(value) = &updates.provider_request_id {
            model.provider_request_id = Set(Some(value.clone()));
        }
        if let Some(value) = &updates.raw_result {
            model.raw_result = Set(Some(value.clone()));
        }
        if let Some(value) = &updates.error {
            model.error = Set(Some(value.clone()));
        }
        model.update(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn get_job(&self, id: &str) -> Result<Option<TranscriptionJob>, Error> {
        self.find_job(id, None).await
    }

    pub async fn get_job_for_user(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<Option<TranscriptionJob>, Error> {
        self.find_job(id, Some(parse_id(user_id)?)).await
    }

    async fn find_job(
        &self,
        id: &str,
        user_id: Option<Uuid>,
    ) -> Result<Option<TranscriptionJob>, Error> {
        let tx = self.database.transaction(&Principal::Service).await?;
        let mut query = job::Entity::find_by_id(parse_id(id)?);
        if let Some(user_id) = user_id {
            query = query.filter(job::Column::UserId.eq(user_id));
        }
        let result = query
            .one(&tx)
            .await?
            .map(|row| {
                Ok(TranscriptionJob {
                    id: row.id.to_string(),
                    user_id: row.user_id.to_string(),
                    file_id: row.file_id,
                    provider: row.provider,
                    status: match row.status.as_str() {
                        "processing" => PipelineStatus::Processing,
                        "done" => PipelineStatus::Done,
                        "error" => PipelineStatus::Error,
                        _ => return Err(Error::InvalidJob),
                    },
                    provider_request_id: row.provider_request_id,
                    raw_result: row.raw_result,
                    error: row.error,
                })
            })
            .transpose()?;
        tx.commit().await?;
        Ok(result)
    }
}

impl PipelineStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Processing => "processing",
            Self::Done => "done",
            Self::Error => "error",
        }
    }
}

fn parse_id(value: &str) -> Result<Uuid, Error> {
    value.parse().map_err(|_| Error::InvalidJob)
}

pub(crate) fn user_owns_object_path(user_id: &str, object_path: &str) -> bool {
    let mut segments = object_path.split('/');
    matches!(segments.next(), Some(owner) if owner == user_id)
        && segments.next().is_some_and(|segment| !segment.is_empty())
}

#[cfg(test)]
mod tests {
    use super::user_owns_object_path;

    #[test]
    fn accepts_only_objects_nested_under_the_exact_user_id() {
        let user_id = "00000000-0000-4000-8000-000000000001";

        assert!(user_owns_object_path(
            user_id,
            &format!("{user_id}/audio.m4a")
        ));
        assert!(!user_owns_object_path(user_id, "audio.m4a"));
        assert!(!user_owns_object_path(user_id, &format!("{user_id}/")));
        assert!(!user_owns_object_path(
            user_id,
            "00000000-0000-4000-8000-000000000002/audio.m4a"
        ));
        assert!(!user_owns_object_path(
            user_id,
            &format!("{user_id}%2Faudio.m4a")
        ));
    }
}
