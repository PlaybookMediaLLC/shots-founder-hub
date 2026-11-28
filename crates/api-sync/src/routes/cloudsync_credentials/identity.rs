use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};

use crate::{
    error::{Result, SyncError},
    state::ReplicaState,
};

pub(in crate::routes) const DEVICE_FINGERPRINT_HEADER: &str = "x-device-fingerprint";
pub(in crate::routes) const DEVICE_NAME_HEADER: &str = "x-anarlog-device-name";
pub(in crate::routes) const E2EE_MEMBER_PUBLIC_KEY_HEADER: &str =
    "x-anarlog-e2ee-member-public-key";
const MAX_DEVICE_NAME_BYTES: usize = 128;

#[derive(Serialize)]
struct ClaimE2eeKeyRpcRequest<'a> {
    p_actor_user_id: &'a str,
    p_key_id: &'a str,
}

#[derive(Deserialize)]
struct E2eeKeyIdRow {
    key_id: String,
}

#[derive(Serialize)]
struct PublishE2eeMemberIdentityRpcRequest<'a> {
    p_public_key: &'a str,
}

#[derive(Deserialize)]
struct E2eeMemberIdentityRow {
    public_key: String,
}

#[derive(Serialize)]
struct ClaimSyncDeviceRpcRequest<'a> {
    p_actor_user_id: &'a str,
    p_device_fingerprint: &'a str,
    p_device_name: Option<&'a str>,
}

#[derive(Deserialize)]
struct SyncDeviceClaimRow {
    allowed: bool,
    device_count: i64,
}

#[derive(Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncDeviceRow {
    #[serde(alias = "device_fingerprint")]
    pub device_fingerprint: String,
    #[serde(alias = "device_name")]
    pub device_name: Option<String>,
    #[serde(alias = "created_at")]
    pub created_at: String,
    #[serde(alias = "last_seen_at")]
    pub last_seen_at: String,
}

#[derive(Serialize)]
struct RemoveSyncDeviceRpcRequest<'a> {
    p_actor_user_id: &'a str,
    p_device_fingerprint: &'a str,
}

#[derive(Serialize)]
struct RenameSyncDeviceRpcRequest<'a> {
    p_actor_user_id: &'a str,
    p_device_fingerprint: &'a str,
    p_device_name: &'a str,
}

pub(super) async fn fetch_sync_device_limit(
    state: &ReplicaState,
    account_user_id: &str,
) -> Result<u8> {
    let limit: u8 = state
        .rpc(
            &anlg_cloud_db::Principal::Service,
            "get_sync_device_limit",
            &serde_json::json!({ "p_actor_user_id": account_user_id }),
        )
        .await
        .map_err(|_| SyncError::Upstream)?;
    match limit {
        limit if limit > 0 => Ok(limit),
        _ => Err(SyncError::Upstream),
    }
}

pub(super) async fn list_sync_devices(
    state: &ReplicaState,
    account_user_id: &str,
) -> Result<Vec<SyncDeviceRow>> {
    use anlg_cloud_db::{Principal, entities::sync_device};
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
    let user_id: uuid::Uuid = account_user_id.parse().map_err(|_| SyncError::Upstream)?;
    let tx = state
        .config
        .database
        .transaction(&Principal::Service)
        .await
        .map_err(|_| SyncError::Upstream)?;
    let rows = sync_device::Entity::find()
        .filter(sync_device::Column::UserId.eq(user_id))
        .order_by_desc(sync_device::Column::LastSeenAt)
        .all(&tx)
        .await
        .map_err(|_| SyncError::Upstream)?;
    tx.commit().await.map_err(|_| SyncError::Upstream)?;
    Ok(rows
        .into_iter()
        .map(|row| SyncDeviceRow {
            device_fingerprint: row.device_fingerprint,
            device_name: row.device_name,
            created_at: row.created_at.to_rfc3339(),
            last_seen_at: row.last_seen_at.to_rfc3339(),
        })
        .collect())
}

pub(super) async fn remove_sync_device(
    state: &ReplicaState,
    account_user_id: &str,
    fingerprint: &str,
) -> Result<()> {
    if !is_valid_device_fingerprint(fingerprint) {
        return Err(SyncError::BadRequest(
            "Sync device identity is invalid".to_string(),
        ));
    }
    let _: serde_json::Value = state
        .rpc(
            &anlg_cloud_db::Principal::Service,
            "remove_sync_device",
            &RemoveSyncDeviceRpcRequest {
                p_actor_user_id: account_user_id,
                p_device_fingerprint: fingerprint,
            },
        )
        .await
        .map_err(|_| SyncError::Upstream)?;
    Ok(())
}

pub(super) async fn rename_sync_device(
    state: &ReplicaState,
    account_user_id: &str,
    fingerprint: &str,
    name: &str,
) -> Result<()> {
    if !is_valid_device_fingerprint(fingerprint) {
        return Err(SyncError::BadRequest(
            "Sync device identity is invalid".to_string(),
        ));
    }
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_DEVICE_NAME_BYTES {
        return Err(SyncError::BadRequest(
            "Sync device name must be between 1 and 128 bytes".to_string(),
        ));
    }
    let _: serde_json::Value = state
        .rpc(
            &anlg_cloud_db::Principal::Service,
            "rename_sync_device",
            &RenameSyncDeviceRpcRequest {
                p_actor_user_id: account_user_id,
                p_device_fingerprint: fingerprint,
                p_device_name: name,
            },
        )
        .await
        .map_err(|_| SyncError::Upstream)?;
    Ok(())
}

pub(super) fn is_valid_device_fingerprint(fingerprint: &str) -> bool {
    (8..=128).contains(&fingerprint.len())
        && fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(super) async fn claim_sync_device(
    state: &ReplicaState,
    account_user_id: &str,
    headers: &HeaderMap,
) -> Result<()> {
    // Older desktop builds do not identify themselves; the limit only
    // applies once the client sends its fingerprint.
    let Some(fingerprint) = headers
        .get(DEVICE_FINGERPRINT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|fingerprint| !fingerprint.is_empty())
    else {
        return Ok(());
    };
    if !is_valid_device_fingerprint(fingerprint) {
        tracing::warn!("sync device fingerprint failed validation; skipping device claim");
        return Ok(());
    }

    let device_name = headers
        .get(DEVICE_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.len() <= MAX_DEVICE_NAME_BYTES);

    let rows: Vec<SyncDeviceClaimRow> = state
        .rpc(
            &anlg_cloud_db::Principal::Service,
            "claim_sync_device",
            &ClaimSyncDeviceRpcRequest {
                p_actor_user_id: account_user_id,
                p_device_fingerprint: fingerprint,
                p_device_name: device_name,
            },
        )
        .await
        .map_err(|_| SyncError::Upstream)?;
    let Some(row) = rows.first() else {
        tracing::warn!("Cloud database sync device claim returned no rows");
        return Err(SyncError::Upstream);
    };
    if !row.allowed {
        tracing::info!(
            device_count = row.device_count,
            "CloudSync device limit reached"
        );
        return Err(SyncError::SyncDeviceLimitReached);
    }
    Ok(())
}

pub(super) async fn claim_personal_e2ee_key(
    state: &ReplicaState,
    account_user_id: &str,
    requested_key_id: &str,
) -> Result<String> {
    if !is_valid_e2ee_key_id(requested_key_id) {
        return Err(SyncError::BadRequest(
            "E2EE key identity is invalid".to_string(),
        ));
    }

    let mut rows: Vec<E2eeKeyIdRow> = state
        .rpc(
            &anlg_cloud_db::Principal::Service,
            "claim_personal_workspace_e2ee_key",
            &ClaimE2eeKeyRpcRequest {
                p_actor_user_id: account_user_id,
                p_key_id: requested_key_id,
            },
        )
        .await
        .map_err(|_| SyncError::Upstream)?;
    if rows.len() != 1 || !is_valid_e2ee_key_id(&rows[0].key_id) {
        tracing::warn!(
            row_count = rows.len(),
            "Cloud database E2EE identity response failed validation"
        );
        return Err(SyncError::Upstream);
    }
    let key_id = rows.pop().expect("row count was checked").key_id;
    if key_id != requested_key_id {
        return Err(SyncError::E2eeKeyMismatch);
    }
    Ok(key_id)
}

pub(super) async fn publish_e2ee_member_identity(
    state: &ReplicaState,
    auth: &anlg_api_auth::AuthContext,
    public_key: &str,
) -> Result<()> {
    if !is_valid_e2ee_member_public_key(public_key) {
        return Err(SyncError::BadRequest(
            "E2EE member identity is invalid".to_string(),
        ));
    }

    let rows: Vec<E2eeMemberIdentityRow> = state
        .rpc(
            &auth.principal().map_err(|_| SyncError::Upstream)?,
            "publish_e2ee_member_identity",
            &PublishE2eeMemberIdentityRpcRequest {
                p_public_key: public_key,
            },
        )
        .await
        .map_err(|_| SyncError::Upstream)?;
    if rows.len() != 1 || rows[0].public_key != public_key {
        tracing::warn!(
            row_count = rows.len(),
            "Cloud database E2EE member identity response failed validation"
        );
        return Err(SyncError::Upstream);
    }
    Ok(())
}

pub(super) fn is_valid_e2ee_key_id(key_id: &str) -> bool {
    key_id.len() == 22
        && key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_valid_e2ee_member_public_key(public_key: &str) -> bool {
    public_key.len() == 43
        && public_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
