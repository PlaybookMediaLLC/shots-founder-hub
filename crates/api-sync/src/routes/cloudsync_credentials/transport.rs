use axum::http::HeaderMap;

use crate::{
    config::CloudsyncTransport,
    error::{Result, SyncError},
    state::ReplicaState,
};

/// Desktop advertises the transports it can accept from `/sync/token`. Older
/// builds omit the header and always receive sqlite-sync credentials, so a
/// server-side flip never strands a client that cannot run the replica path.
pub(in crate::routes) const CLOUDSYNC_TRANSPORTS_HEADER: &str = "x-anarlog-cloudsync-transports";

pub(super) fn client_accepts_replica_transport(headers: &HeaderMap) -> bool {
    headers
        .get_all(CLOUDSYNC_TRANSPORTS_HEADER)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|transport| transport.trim() == "replica")
}

pub(super) async fn resolve_desktop_transport(
    state: &ReplicaState,
    account_user_id: &str,
    default: CloudsyncTransport,
) -> Result<CloudsyncTransport> {
    use anlg_cloud_db::{Principal, entities::sync_transport_override};
    use sea_orm::EntityTrait;
    let user_id: uuid::Uuid = account_user_id.parse().map_err(|_| SyncError::Upstream)?;
    let tx = state
        .config
        .database
        .transaction(&Principal::Service)
        .await
        .map_err(|_| SyncError::Upstream)?;
    let row = sync_transport_override::Entity::find_by_id(user_id)
        .one(&tx)
        .await
        .map_err(|_| SyncError::Upstream)?;
    tx.commit().await.map_err(|_| SyncError::Upstream)?;
    match row.as_ref().map(|row| row.transport.as_str()) {
        None => Ok(default),
        Some("replica") => Ok(CloudsyncTransport::Replica),
        Some("sqlite_sync") => Ok(CloudsyncTransport::SqliteSync),
        Some(other) => {
            tracing::warn!(transport = other, "unknown sync transport override");
            Err(SyncError::Upstream)
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    #[test]
    fn accepts_replica_only_when_advertised() {
        let mut headers = HeaderMap::new();
        assert!(!client_accepts_replica_transport(&headers));

        headers.insert(
            CLOUDSYNC_TRANSPORTS_HEADER,
            HeaderValue::from_static("sqlite_sync"),
        );
        assert!(!client_accepts_replica_transport(&headers));

        headers.insert(
            CLOUDSYNC_TRANSPORTS_HEADER,
            HeaderValue::from_static("sqlite_sync, replica"),
        );
        assert!(client_accepts_replica_transport(&headers));
    }
}
