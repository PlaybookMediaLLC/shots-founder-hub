use anlg_cloud_db::{Principal, entities::file_upload};
use anlg_r2_storage::{MAX_OBJECT_SIZE, PART_SIZE};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseTransaction, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QuerySelect, Set, Statement,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::state::AppState;

type Result<T> = std::result::Result<T, StatusCode>;

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn active_account(tx: &DatabaseTransaction, owner: Uuid) -> Result<()> {
    let deleted = tx
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 WHERE NOT founder_hub_private.shots_account_available($1)",
            [owner.into()],
        ))
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .is_some();
    if deleted {
        return Err(StatusCode::GONE);
    }
    Ok(())
}

pub(crate) async fn grant(
    state: &AppState,
    owner: &str,
    bucket: &str,
    key: &str,
    content_type: &str,
    size: u64,
    metadata: Value,
    expires_at: &str,
) -> Result<String> {
    let owner: Uuid = owner.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let expiry =
        chrono::DateTime::parse_from_rfc3339(expires_at).map_err(|_| StatusCode::BAD_REQUEST)?;
    if size == 0 || size > MAX_OBJECT_SIZE || expiry <= chrono::Utc::now() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let tx = state
        .config
        .database
        .transaction(&Principal::Service)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    tx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [format!("{bucket}/{key}").into()],
    ))
    .await
    .map_err(|_| StatusCode::BAD_GATEWAY)?;
    active_account(&tx, owner).await?;
    let existing = file_upload::Entity::find()
        .filter(file_upload::Column::Bucket.eq(bucket))
        .filter(file_upload::Column::ObjectKey.eq(key))
        .lock_exclusive()
        .one(&tx)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    if let Some(row) = existing {
        let mut stored_metadata = row.metadata.clone();
        stored_metadata
            .as_object_mut()
            .ok_or(StatusCode::BAD_GATEWAY)?
            .remove("uploadSession");
        if row.owner_user_id != owner
            || row.content_type != content_type
            || row.size_bytes != size as i64
            || stored_metadata != metadata
        {
            return Err(StatusCode::CONFLICT);
        }
        let restart = row.status == "aborted";
        let mut row = row.into_active_model();
        if restart {
            let mut metadata = metadata;
            metadata
                .as_object_mut()
                .ok_or(StatusCode::BAD_REQUEST)?
                .insert("uploadSession".into(), json!(Uuid::new_v4()));
            let upload_id = state
                .storage
                .begin_upload(bucket, key, content_type, &metadata)
                .await
                .map_err(|_| StatusCode::BAD_GATEWAY)?;
            row.upload_id = Set(upload_id);
            row.metadata = Set(metadata);
            row.status = Set("active".into());
        }
        row.token_hash = Set(hash(&token));
        row.expires_at = Set(expiry);
        row.update(&tx).await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    } else {
        let id = Uuid::new_v4();
        let mut metadata = metadata;
        metadata
            .as_object_mut()
            .ok_or(StatusCode::BAD_REQUEST)?
            .insert("uploadSession".into(), json!(id));
        let upload_id = state
            .storage
            .begin_upload(bucket, key, content_type, &metadata)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let result = file_upload::ActiveModel {
            id: Set(id),
            bucket: Set(bucket.into()),
            object_key: Set(key.into()),
            owner_user_id: Set(owner),
            token_hash: Set(hash(&token)),
            upload_id: Set(upload_id.clone()),
            content_type: Set(content_type.into()),
            metadata: Set(metadata),
            size_bytes: Set(size as i64),
            status: Set("active".into()),
            expires_at: Set(expiry),
            ..Default::default()
        }
        .insert(&tx)
        .await;
        if result.is_err() {
            let _ = state.storage.abort_upload(bucket, key, &upload_id).await;
            return Err(StatusCode::BAD_GATEWAY);
        }
    }
    tx.commit().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(token)
}

async fn authorized(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(DatabaseTransaction, file_upload::Model)> {
    let token = headers
        .get("x-upload-token")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let tx = state
        .config
        .database
        .transaction(&Principal::Service)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let row = file_upload::Entity::find()
        .filter(file_upload::Column::TokenHash.eq(hash(token)))
        .lock_exclusive()
        .one(&tx)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    active_account(&tx, row.owner_user_id).await?;
    if row.expires_at <= chrono::Utc::now() || row.status == "aborted" {
        return Err(StatusCode::GONE);
    }
    Ok((tx, row))
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/files/uploads/status", post(status))
        .route("/files/uploads/part", post(part))
        .route("/files/uploads/complete", post(complete))
        .route("/files/uploads/abort", post(abort))
        .layer(axum::extract::DefaultBodyLimit::max(1024))
        .with_state(state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadStatus {
    status: String,
    size: u64,
    chunk_size: u64,
    parts: Vec<anlg_r2_storage::Part>,
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<UploadStatus>> {
    let (tx, row) = authorized(&state, &headers).await?;
    let parts = if row.status == "active" {
        state
            .storage
            .list_parts(&row.bucket, &row.object_key, &row.upload_id)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?
    } else {
        vec![]
    };
    tx.commit().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(UploadStatus {
        status: row.status,
        size: row.size_bytes as u64,
        chunk_size: PART_SIZE,
        parts,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PartRequest {
    number: i32,
}

async fn part(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PartRequest>,
) -> Result<Json<Value>> {
    let (tx, row) = authorized(&state, &headers).await?;
    if row.status != "active" {
        return Err(StatusCode::CONFLICT);
    }
    let size = row.size_bytes as u64;
    if request.number < 1 || request.number as u64 > size.div_ceil(PART_SIZE) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let size = (size - (request.number as u64 - 1) * PART_SIZE).min(PART_SIZE);
    let url = state
        .storage
        .upload_part_url(
            &row.bucket,
            &row.object_key,
            &row.upload_id,
            request.number,
            size,
        )
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    tx.commit().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(json!({"url": url, "size": size})))
}

async fn complete(State(state): State<AppState>, headers: HeaderMap) -> Result<StatusCode> {
    let (tx, row) = authorized(&state, &headers).await?;
    if row.status == "complete" {
        return Ok(StatusCode::NO_CONTENT);
    }
    if state
        .storage
        .complete_upload(
            &row.bucket,
            &row.object_key,
            &row.upload_id,
            row.size_bytes as u64,
        )
        .await
        .is_err()
    {
        // A lost S3 response can still mean completion succeeded; bind recovery to this upload.
        let object = state
            .storage
            .object_metadata(&row.bucket, &row.object_key)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        if object.size_bytes != row.size_bytes as u64
            || object.user_metadata != row.metadata
            || object.content_type != row.content_type
        {
            return Err(StatusCode::CONFLICT);
        }
    }
    tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO founder_hub_files.objects(bucket_id,name,owner,metadata) VALUES($1,$2,$3,$4) ON CONFLICT(bucket_id,name) DO UPDATE SET metadata=EXCLUDED.metadata, updated_at=now()",
        [row.bucket.clone().into(), row.object_key.clone().into(), row.owner_user_id.to_string().into(), json!({"size":row.size_bytes,"mimetype":row.content_type}).into()]))
        .await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut model = row.into_active_model();
    model.status = Set("complete".into());
    model
        .update(&tx)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    tx.commit().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn abort(State(state): State<AppState>, headers: HeaderMap) -> Result<StatusCode> {
    let (tx, row) = authorized(&state, &headers).await?;
    if row.status == "complete" {
        return Err(StatusCode::CONFLICT);
    }
    state
        .storage
        .abort_upload(&row.bucket, &row.object_key, &row.upload_id)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut model = row.into_active_model();
    model.status = Set("aborted".into());
    model
        .update(&tx)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    tx.commit().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn file_router(state: AppState) -> Router {
    Router::new()
        .route("/files/begin", post(begin))
        .route("/files/download", post(download))
        .route("/files/remove", post(remove))
        .layer(axum::extract::DefaultBodyLimit::max(4096))
        .with_state(state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BeginRequest {
    bucket: String,
    key: String,
    content_type: String,
    size: u64,
}

fn owned_file(bucket: &str, key: &str, owner: &str) -> Result<()> {
    if !matches!(bucket, "audio-files" | "profile-avatars")
        || !key.starts_with(&format!("{owner}/"))
        || key.split('/').count() != 2
        || key.contains('\\')
        || key.chars().any(char::is_control)
        || key.ends_with("/.")
        || key.ends_with("/..")
        || key.ends_with('/')
        || key.len() > 900
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
}

async fn begin(
    State(state): State<AppState>,
    axum::Extension(auth): axum::Extension<anlg_api_auth::AuthContext>,
    Json(request): Json<BeginRequest>,
) -> Result<Json<Value>> {
    owned_file(&request.bucket, &request.key, &auth.claims.sub)?;
    if request.size == 0
        || request.size > MAX_OBJECT_SIZE
        || request.bucket == "profile-avatars"
            && (request.size > 262144
                || !matches!(request.content_type.as_str(), "image/jpeg" | "image/png"))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = auth.principal().map_err(|_| StatusCode::UNAUTHORIZED)?;
    let tx = state
        .config
        .database
        .transaction(&principal)
        .await
        .map_err(|_| StatusCode::FORBIDDEN)?;
    tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO founder_hub_files.objects(bucket_id,name,owner,metadata) VALUES($1,$2,$3,$4) ON CONFLICT(bucket_id,name) DO NOTHING",
        [request.bucket.clone().into(), request.key.clone().into(), auth.claims.sub.clone().into(), json!({"size":request.size,"mimetype":request.content_type}).into()]))
        .await.map_err(|_| StatusCode::FORBIDDEN)?;
    tx.commit().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let expiry = (chrono::Utc::now() + chrono::Duration::minutes(30)).to_rfc3339();
    let token = grant(
        &state,
        &auth.claims.sub,
        &request.bucket,
        &request.key,
        &request.content_type,
        request.size,
        json!({}),
        &expiry,
    )
    .await?;
    Ok(Json(json!({"token":token,"expiresAt":expiry})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRequest {
    bucket: String,
    key: String,
}

async fn download(
    State(state): State<AppState>,
    axum::Extension(auth): axum::Extension<anlg_api_auth::AuthContext>,
    Json(request): Json<FileRequest>,
) -> Result<Json<Value>> {
    owned_file(&request.bucket, &request.key, &auth.claims.sub)?;
    let tx = state
        .config
        .database
        .transaction(&auth.principal().map_err(|_| StatusCode::UNAUTHORIZED)?)
        .await
        .map_err(|_| StatusCode::FORBIDDEN)?;
    let row = tx
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM founder_hub_files.objects WHERE bucket_id=$1 AND name=$2",
            [request.bucket.clone().into(), request.key.clone().into()],
        ))
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if row.is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    tx.commit().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let url = state
        .storage
        .create_signed_url(&request.bucket, &request.key, 300)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(json!({"signedUrl":url})))
}

async fn remove(
    State(state): State<AppState>,
    axum::Extension(auth): axum::Extension<anlg_api_auth::AuthContext>,
    Json(request): Json<FileRequest>,
) -> Result<StatusCode> {
    owned_file(&request.bucket, &request.key, &auth.claims.sub)?;
    let principal = auth.principal().map_err(|_| StatusCode::UNAUTHORIZED)?;
    let tx = state
        .config
        .database
        .transaction(&principal)
        .await
        .map_err(|_| StatusCode::FORBIDDEN)?;
    tx.commit().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    state
        .storage
        .delete_catalog_file(&state.config.database, &request.bucket, &request.key)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(StatusCode::NO_CONTENT)
}
