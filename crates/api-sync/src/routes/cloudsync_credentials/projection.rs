use std::collections::HashSet;

use anlg_api_auth::AuthContext;
use serde::{Deserialize, Serialize};

use crate::{
    error::{Result, SyncError},
    state::ReplicaState,
};

pub(in crate::routes) const MAX_TOKEN_WORKSPACES: usize = 128;
pub(in crate::routes) const MAX_TOKEN_ATTRIBUTES_BYTES: usize = 8 * 1024;

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloudsyncWorkspace {
    pub(in crate::routes) id: String,
    pub(in crate::routes) owner_user_id: String,
    pub(in crate::routes) kind: String,
    pub(in crate::routes) name: String,
    pub(in crate::routes) membership_id: String,
    pub(in crate::routes) role: String,
    pub(in crate::routes) membership_created_at: String,
    pub(in crate::routes) membership_updated_at: String,
    pub(in crate::routes) created_at: String,
    pub(in crate::routes) updated_at: String,
}

#[derive(Deserialize)]
pub(super) struct WorkspaceMembershipRow {
    id: String,
    user_id: String,
    role: String,
    created_at: String,
    updated_at: String,
    workspace: WorkspaceRow,
}

#[derive(Deserialize)]
pub(super) struct WorkspaceRow {
    id: String,
    owner_user_id: String,
    kind: String,
    name: String,
    created_at: String,
    updated_at: String,
}

pub(super) async fn fetch_workspace_projection(
    state: &ReplicaState,
    auth: &AuthContext,
) -> Result<Vec<WorkspaceMembershipRow>> {
    use anlg_cloud_db::entities::{workspace, workspace_membership};
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
    let user_id: uuid::Uuid = auth.claims.sub.parse().map_err(|_| SyncError::Upstream)?;
    let tx = state
        .config
        .database
        .transaction(&auth.principal().map_err(|_| SyncError::Upstream)?)
        .await
        .map_err(|_| SyncError::Upstream)?;
    let rows = workspace_membership::Entity::find()
        .filter(workspace_membership::Column::UserId.eq(user_id))
        .filter(workspace_membership::Column::DeletedAt.is_null())
        .find_also_related(workspace::Entity)
        .filter(workspace::Column::DeletedAt.is_null())
        .limit(MAX_TOKEN_WORKSPACES as u64 + 1)
        .all(&tx)
        .await
        .map_err(|_| SyncError::Upstream)?;
    let rows = rows
        .into_iter()
        .map(|(member, workspace)| {
            let workspace = workspace.ok_or(SyncError::Upstream)?;
            Ok(WorkspaceMembershipRow {
                id: member.id.to_string(),
                user_id: member.user_id.to_string(),
                role: member.role,
                created_at: member.created_at.to_rfc3339(),
                updated_at: member.updated_at.to_rfc3339(),
                workspace: WorkspaceRow {
                    id: workspace.id.to_string(),
                    owner_user_id: workspace.owner_user_id.to_string(),
                    kind: workspace.kind,
                    name: workspace.name,
                    created_at: workspace.created_at.to_rfc3339(),
                    updated_at: workspace.updated_at.to_rfc3339(),
                },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    tx.commit().await.map_err(|_| SyncError::Upstream)?;
    Ok(rows)
}

pub(super) fn validate_workspace_projection(
    mut rows: Vec<WorkspaceMembershipRow>,
    account_user_id: &str,
) -> Result<(String, Vec<CloudsyncWorkspace>)> {
    let mut membership_ids = HashSet::with_capacity(rows.len());
    let mut workspace_ids = HashSet::with_capacity(rows.len());

    for row in &rows {
        if row.user_id != account_user_id {
            return invalid_workspace_projection("membership user does not match account");
        }
        if row.id.trim().is_empty()
            || row.workspace.id.trim().is_empty()
            || row.workspace.owner_user_id.trim().is_empty()
        {
            return invalid_workspace_projection("workspace projection contains a blank identity");
        }
        if !matches!(row.role.as_str(), "owner" | "admin" | "member") {
            return invalid_workspace_projection("workspace membership has an invalid role");
        }
        if !matches!(row.workspace.kind.as_str(), "personal" | "shared") {
            return invalid_workspace_projection("workspace has an invalid kind");
        }
        if chrono::DateTime::parse_from_rfc3339(&row.workspace.created_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&row.workspace.updated_at).is_err()
        {
            return invalid_workspace_projection("workspace has an invalid timestamp");
        }
        if chrono::DateTime::parse_from_rfc3339(&row.created_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&row.updated_at).is_err()
        {
            return invalid_workspace_projection("workspace membership has an invalid timestamp");
        }
        if !membership_ids.insert(&row.id) || !workspace_ids.insert(&row.workspace.id) {
            return invalid_workspace_projection("workspace projection contains duplicate rows");
        }
    }

    let personal_workspaces = rows
        .iter()
        .filter(|row| row.workspace.kind == "personal")
        .collect::<Vec<_>>();
    if personal_workspaces.len() != 1 {
        return invalid_workspace_projection(
            "account must have exactly one personal owner workspace",
        );
    }

    let personal_workspace = personal_workspaces[0];
    if personal_workspace.role != "owner"
        || personal_workspace.workspace.id != account_user_id
        || personal_workspace.workspace.owner_user_id != account_user_id
    {
        return invalid_workspace_projection("personal workspace identity does not match account");
    }

    let personal_workspace_id = personal_workspace.workspace.id.clone();
    rows.sort_by(|left, right| {
        let left_is_personal = left.workspace.id == personal_workspace_id;
        let right_is_personal = right.workspace.id == personal_workspace_id;
        right_is_personal
            .cmp(&left_is_personal)
            .then_with(|| left.workspace.created_at.cmp(&right.workspace.created_at))
            .then_with(|| left.workspace.id.cmp(&right.workspace.id))
    });

    Ok((
        personal_workspace_id,
        rows.into_iter()
            .map(|row| CloudsyncWorkspace {
                id: row.workspace.id,
                owner_user_id: row.workspace.owner_user_id,
                kind: row.workspace.kind,
                name: row.workspace.name,
                membership_id: row.id,
                role: row.role,
                membership_created_at: row.created_at,
                membership_updated_at: row.updated_at,
                created_at: row.workspace.created_at,
                updated_at: row.workspace.updated_at,
            })
            .collect(),
    ))
}

fn invalid_workspace_projection<T>(reason: &'static str) -> Result<T> {
    tracing::warn!(
        reason,
        "Cloud database workspace projection failed validation"
    );
    Err(SyncError::Upstream)
}

pub(in crate::routes) fn encode_workspace_token_attributes(
    workspaces: &[CloudsyncWorkspace],
) -> Result<String> {
    if workspaces.len() > MAX_TOKEN_WORKSPACES {
        tracing::warn!(
            workspace_count = workspaces.len(),
            "CloudSync workspace projection exceeds token limit"
        );
        return Err(SyncError::Upstream);
    }

    let attributes = serde_json::to_string(&serde_json::json!({
        "workspace_ids": workspaces
            .iter()
            .map(|workspace| workspace.id.as_str())
            .collect::<Vec<_>>(),
    }))
    .map_err(|error| {
        SyncError::Internal(format!("CloudSync token attributes are invalid: {error}"))
    })?;
    if attributes.len() > MAX_TOKEN_ATTRIBUTES_BYTES {
        tracing::warn!(
            attribute_bytes = attributes.len(),
            "CloudSync workspace projection exceeds token size limit"
        );
        return Err(SyncError::Upstream);
    }

    Ok(attributes)
}
