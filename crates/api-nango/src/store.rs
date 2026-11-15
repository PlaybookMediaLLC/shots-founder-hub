#[derive(serde::Deserialize)]
pub(crate) struct NangoConnectionRow {
    #[serde(default)]
    pub integration_id: String,
    pub connection_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub last_error_type: Option<String>,
    #[serde(default)]
    pub last_error_description: Option<String>,
    #[serde(default)]
    pub last_error_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(serde::Deserialize)]
pub(crate) struct LookupConnectionRow {
    pub connection_id: String,
    #[serde(default)]
    pub status: String,
}

use crate::error::{NangoError, Result};
use anlg_api_auth::AuthContext;
use anlg_cloud_db::{Database, Principal, entities::nango_connection as connection};
use sea_orm::{
    ColumnTrait, EntityTrait, QueryFilter, Set,
    sea_query::{Expr, ExprTrait, OnConflict},
};

fn database_error(_: impl std::fmt::Display) -> NangoError {
    NangoError::Internal("connection database request failed".into())
}

#[derive(Clone)]
pub(crate) struct ConnectionStore(Database);

impl ConnectionStore {
    pub(crate) fn new(database: Database) -> Self {
        Self(database)
    }

    async fn rows(
        &self,
        auth: &AuthContext,
        user_id: &str,
        integration_id: Option<&str>,
    ) -> Result<Vec<connection::Model>> {
        if auth.claims.sub != user_id {
            return Err(NangoError::Auth("not authenticated".into()));
        }
        let principal = auth
            .principal()
            .map_err(|_| NangoError::Auth("not authenticated".into()))?;
        let user_id: uuid::Uuid = user_id
            .parse()
            .map_err(|_| NangoError::Auth("not authenticated".into()))?;
        let tx = self
            .0
            .transaction(&principal)
            .await
            .map_err(database_error)?;
        let mut query = connection::Entity::find().filter(connection::Column::UserId.eq(user_id));
        if let Some(id) = integration_id {
            query = query.filter(connection::Column::IntegrationId.eq(id));
        }
        let rows = query.all(&tx).await.map_err(database_error)?;
        tx.commit().await.map_err(database_error)?;
        Ok(rows)
    }

    pub(crate) async fn connection(
        &self,
        auth: &AuthContext,
        user_id: &str,
        integration_id: &str,
        connection_id: Option<&str>,
    ) -> Result<Option<LookupConnectionRow>> {
        Ok(self
            .rows(auth, user_id, Some(integration_id))
            .await?
            .into_iter()
            .find(|row| connection_id.is_none_or(|id| row.connection_id == id))
            .map(|row| LookupConnectionRow {
                connection_id: row.connection_id,
                status: row.status,
            }))
    }

    pub(crate) async fn verify_connection_ownership(
        &self,
        auth: &AuthContext,
        user_id: &str,
        connection_id: &str,
        integration_id: &str,
    ) -> Result<bool> {
        Ok(self
            .connection(auth, user_id, integration_id, Some(connection_id))
            .await?
            .is_some())
    }

    pub(crate) async fn lookup_connection(
        &self,
        auth: &AuthContext,
        user_id: &str,
        integration_id: &str,
    ) -> Result<Option<LookupConnectionRow>> {
        self.connection(auth, user_id, integration_id, None).await
    }

    pub(crate) async fn list_user_connections(
        &self,
        auth: &AuthContext,
        user_id: &str,
    ) -> Result<Vec<NangoConnectionRow>> {
        Ok(self
            .rows(auth, user_id, None)
            .await?
            .into_iter()
            .map(|row| NangoConnectionRow {
                integration_id: row.integration_id,
                connection_id: row.connection_id,
                status: row.status,
                last_error_type: row.last_error_type,
                last_error_description: row.last_error_description,
                last_error_at: row.last_error_at.map(|value| value.to_rfc3339()),
                updated_at: Some(row.updated_at.to_rfc3339()),
            })
            .collect())
    }

    pub(crate) async fn upsert_connection(
        &self,
        user_id: &str,
        integration_id: &str,
        connection_id: &str,
        provider: &str,
    ) -> Result<()> {
        let user_id: uuid::Uuid = user_id.parse().map_err(database_error)?;
        let tx = self
            .0
            .transaction(&Principal::Service)
            .await
            .map_err(database_error)?;
        connection::Entity::insert(connection::ActiveModel {
            user_id: Set(user_id),
            integration_id: Set(integration_id.into()),
            connection_id: Set(connection_id.into()),
            provider: Set(provider.into()),
            status: Set("connected".into()),
            last_error_type: Set(None),
            last_error_description: Set(None),
            last_error_at: Set(None),
            updated_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::columns([
                connection::Column::IntegrationId,
                connection::Column::ConnectionId,
            ])
            .update_columns([
                connection::Column::Provider,
                connection::Column::Status,
                connection::Column::LastErrorType,
                connection::Column::LastErrorDescription,
                connection::Column::LastErrorAt,
                connection::Column::UpdatedAt,
            ])
            .action_and_where(
                Expr::col((connection::Entity, connection::Column::UserId)).eq(user_id),
            )
            .to_owned(),
        )
        .exec(&tx)
        .await
        .map_err(database_error)?;
        tx.commit().await.map_err(database_error)
    }

    pub(crate) async fn delete_connection(
        &self,
        user_id: &str,
        integration_id: &str,
    ) -> Result<()> {
        let user_id: uuid::Uuid = user_id.parse().map_err(database_error)?;
        let tx = self
            .0
            .transaction(&Principal::Service)
            .await
            .map_err(database_error)?;
        connection::Entity::delete_many()
            .filter(connection::Column::UserId.eq(user_id))
            .filter(connection::Column::IntegrationId.eq(integration_id))
            .exec(&tx)
            .await
            .map_err(database_error)?;
        tx.commit().await.map_err(database_error)
    }

    pub(crate) async fn delete_connection_by_connection(
        &self,
        integration_id: &str,
        connection_id: &str,
    ) -> Result<()> {
        let tx = self
            .0
            .transaction(&Principal::Service)
            .await
            .map_err(database_error)?;
        connection::Entity::delete_many()
            .filter(connection::Column::IntegrationId.eq(integration_id))
            .filter(connection::Column::ConnectionId.eq(connection_id))
            .exec(&tx)
            .await
            .map_err(database_error)?;
        tx.commit().await.map_err(database_error)
    }

    pub(crate) async fn mark_connection_refresh_failed(
        &self,
        integration_id: &str,
        connection_id: &str,
        error_type: Option<&str>,
        error_description: Option<&str>,
    ) -> Result<()> {
        let tx = self
            .0
            .transaction(&Principal::Service)
            .await
            .map_err(database_error)?;
        connection::Entity::update_many()
            .set(connection::ActiveModel {
                status: Set("reconnect_required".into()),
                last_error_type: Set(error_type.map(str::to_owned)),
                last_error_description: Set(error_description.map(str::to_owned)),
                last_error_at: Set(Some(chrono::Utc::now().into())),
                updated_at: Set(chrono::Utc::now().into()),
                ..Default::default()
            })
            .filter(connection::Column::IntegrationId.eq(integration_id))
            .filter(connection::Column::ConnectionId.eq(connection_id))
            .exec(&tx)
            .await
            .map_err(database_error)?;
        tx.commit().await.map_err(database_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn connection_conflicts_cannot_update_another_accounts_provider_or_status() {
        let database = Database::new(
            &std::env::var("CLOUD_DATABASE_TEST_URL").expect("isolated PostgreSQL required"),
        )
        .unwrap();
        let owner = crate::config::test_user(&database).await;
        let other = crate::config::test_user(&database).await;
        let id = format!("conn-{owner}");
        let store = ConnectionStore::new(database.clone());
        store
            .upsert_connection(&owner.to_string(), "calendar", &id, "original")
            .await
            .unwrap();
        store
            .mark_connection_refresh_failed("calendar", &id, Some("expired"), None)
            .await
            .unwrap();
        assert!(
            store
                .upsert_connection(&other.to_string(), "calendar", &id, "replacement")
                .await
                .is_err()
        );
        let row = connection::Entity::find()
            .filter(connection::Column::ConnectionId.eq(&id))
            .one(database.connection().await.unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.user_id, owner);
        assert_eq!(row.provider, "original");
        assert_eq!(row.status, "reconnect_required");
    }
}
