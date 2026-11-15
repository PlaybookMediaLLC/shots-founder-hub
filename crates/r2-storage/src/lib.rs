mod catalog;
use std::time::Duration;

use aws_sdk_s3::{
    Client,
    config::{BehaviorVersion, Region, RequestChecksumCalculation, ResponseChecksumValidation},
    presigning::PresigningConfig,
    types::{CompletedMultipartUpload, CompletedPart, Delete, ObjectIdentifier},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const PART_SIZE: u64 = 6 * 1024 * 1024;
pub const MAX_OBJECT_SIZE: u64 = 520 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const VERIFICATION_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Deserialize)]
pub struct Config {
    pub r2_endpoint: String,
    pub r2_bucket: String,
    pub r2_access_key_id: String,
    pub r2_secret_access_key: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("R2 configuration is invalid")]
    Configuration,
    #[error("storage object path is invalid")]
    InvalidPath,
    #[error("storage operation was cancelled")]
    Cancelled,
    #[error("storage operation failed: {0}")]
    Api(&'static str),
}

#[derive(Clone)]
pub struct Storage {
    client: Client,
    bucket: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectInfo {
    pub size_bytes: u64,
    pub content_type: String,
    pub ciphertext_sha256: String,
    pub format_version: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectMetadata {
    pub size_bytes: u64,
    pub content_type: String,
    pub user_metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Part {
    pub number: i32,
    pub size: u64,
    pub etag: String,
}

impl Storage {
    pub fn new(config: &Config) -> Result<Self, Error> {
        let endpoint = url::Url::parse(&config.r2_endpoint).map_err(|_| Error::Configuration)?;
        let local = matches!(
            endpoint.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]")
        );
        if !(endpoint.scheme() == "https" || local && endpoint.scheme() == "http")
            || endpoint.path() != "/"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || config.r2_bucket.is_empty()
            || config.r2_bucket.len() > 63
            || !config
                .r2_bucket
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || config.r2_access_key_id.is_empty()
            || config.r2_secret_access_key.is_empty()
        {
            return Err(Error::Configuration);
        }
        let credentials = aws_credential_types::Credentials::new(
            &config.r2_access_key_id,
            &config.r2_secret_access_key,
            None,
            None,
            "r2",
        );
        let client = Client::from_conf(
            aws_sdk_s3::Config::builder()
                .behavior_version(BehaviorVersion::latest())
                .region(Region::new("auto"))
                .endpoint_url(endpoint.as_str())
                .force_path_style(true)
                .credentials_provider(credentials)
                .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
                .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
                .timeout_config(
                    aws_sdk_s3::config::timeout::TimeoutConfig::builder()
                        .connect_timeout(Duration::from_secs(10))
                        .operation_timeout(REQUEST_TIMEOUT)
                        .build(),
                )
                .build(),
        );
        Ok(Self {
            client,
            bucket: config.r2_bucket.clone(),
        })
    }

    fn key(bucket: &str, path: &str) -> Result<String, Error> {
        if !matches!(
            bucket,
            "audio-files" | "attachment-backups" | "shared-note-attachments" | "profile-avatars"
        ) || path.is_empty()
            || bucket.len() + path.len() + 1 > 1024
            || path.contains('\\')
            || path.chars().any(char::is_control)
            || path
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | ".."))
        {
            return Err(Error::InvalidPath);
        }
        Ok(format!("{bucket}/{path}"))
    }

    fn expiry(seconds: u64) -> Result<PresigningConfig, Error> {
        if !(1..=3600).contains(&seconds) {
            return Err(Error::Api("invalid signed URL expiry"));
        }
        PresigningConfig::expires_in(Duration::from_secs(seconds))
            .map_err(|_| Error::Api("invalid signed URL expiry"))
    }

    pub async fn create_signed_url(
        &self,
        bucket: &str,
        path: &str,
        seconds: u64,
    ) -> Result<String, Error> {
        Ok(self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(Self::key(bucket, path)?)
            .presigned(Self::expiry(seconds)?)
            .await
            .map_err(|_| Error::Api("sign download"))?
            .uri()
            .into())
    }

    pub async fn begin_upload(
        &self,
        bucket: &str,
        path: &str,
        content_type: &str,
        metadata: &Value,
    ) -> Result<String, Error> {
        let metadata =
            serde_json::to_string(metadata).map_err(|_| Error::Api("invalid object metadata"))?;
        if metadata.len() > 1536
            || !metadata.is_ascii()
            || content_type.is_empty()
            || content_type.len() > 255
            || content_type.chars().any(char::is_control)
        {
            return Err(Error::Api("invalid object metadata"));
        }
        self.client
            .create_multipart_upload()
            .bucket(&self.bucket)
            .key(Self::key(bucket, path)?)
            .content_type(content_type)
            .metadata("application", metadata)
            .send()
            .await
            .map_err(|_| Error::Api("begin upload"))?
            .upload_id()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or(Error::Api("missing upload id"))
    }

    pub async fn upload_part_url(
        &self,
        bucket: &str,
        path: &str,
        upload_id: &str,
        number: i32,
        size: u64,
    ) -> Result<String, Error> {
        if upload_id.is_empty() || !(1..=87).contains(&number) || size == 0 || size > PART_SIZE {
            return Err(Error::Api("invalid upload part"));
        }
        Ok(self
            .client
            .upload_part()
            .bucket(&self.bucket)
            .key(Self::key(bucket, path)?)
            .upload_id(upload_id)
            .part_number(number)
            .content_length(size as i64)
            .presigned(Self::expiry(900)?)
            .await
            .map_err(|_| Error::Api("sign upload part"))?
            .uri()
            .into())
    }

    pub async fn list_parts(
        &self,
        bucket: &str,
        path: &str,
        upload_id: &str,
    ) -> Result<Vec<Part>, Error> {
        let response = self
            .client
            .list_parts()
            .bucket(&self.bucket)
            .key(Self::key(bucket, path)?)
            .upload_id(upload_id)
            .max_parts(100)
            .send()
            .await
            .map_err(|_| Error::Api("list upload parts"))?;
        if response.is_truncated() == Some(true) {
            return Err(Error::Api("too many upload parts"));
        }
        response
            .parts()
            .iter()
            .map(|part| {
                Ok(Part {
                    number: part
                        .part_number()
                        .ok_or(Error::Api("invalid upload part"))?,
                    size: part
                        .size()
                        .and_then(|size| u64::try_from(size).ok())
                        .ok_or(Error::Api("invalid upload part"))?,
                    etag: part
                        .e_tag()
                        .filter(|tag| !tag.is_empty())
                        .ok_or(Error::Api("invalid upload part"))?
                        .to_owned(),
                })
            })
            .collect()
    }

    pub async fn complete_upload(
        &self,
        bucket: &str,
        path: &str,
        upload_id: &str,
        expected_size: u64,
    ) -> Result<(), Error> {
        let parts = self.list_parts(bucket, path, upload_id).await?;
        validate_parts(&parts, expected_size)?;
        let parts = parts
            .into_iter()
            .map(|part| {
                CompletedPart::builder()
                    .part_number(part.number)
                    .e_tag(part.etag)
                    .build()
            })
            .collect();
        self.client
            .complete_multipart_upload()
            .bucket(&self.bucket)
            .key(Self::key(bucket, path)?)
            .upload_id(upload_id)
            .multipart_upload(
                CompletedMultipartUpload::builder()
                    .set_parts(Some(parts))
                    .build(),
            )
            .send()
            .await
            .map_err(|_| Error::Api("complete upload"))?;
        Ok(())
    }

    pub async fn abort_upload(
        &self,
        bucket: &str,
        path: &str,
        upload_id: &str,
    ) -> Result<(), Error> {
        let result = self
            .client
            .abort_multipart_upload()
            .bucket(&self.bucket)
            .key(Self::key(bucket, path)?)
            .upload_id(upload_id)
            .send()
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|error| error.is_no_such_upload()) =>
            {
                Ok(())
            }
            Err(_) => Err(Error::Api("abort upload")),
        }
    }

    pub async fn object_metadata(&self, bucket: &str, path: &str) -> Result<ObjectMetadata, Error> {
        let response = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(Self::key(bucket, path)?)
            .send()
            .await
            .map_err(|_| Error::Api("read object metadata"))?;
        let metadata = response
            .metadata()
            .and_then(|metadata| metadata.get("application"))
            .ok_or(Error::Api("missing object metadata"))?;
        Ok(ObjectMetadata {
            size_bytes: response
                .content_length()
                .and_then(|size| size.try_into().ok())
                .ok_or(Error::Api("missing object size"))?,
            content_type: response
                .content_type()
                .filter(|value| !value.is_empty())
                .ok_or(Error::Api("missing content type"))?
                .into(),
            user_metadata: serde_json::from_str(metadata)
                .map_err(|_| Error::Api("invalid object metadata"))?,
        })
    }

    pub async fn object_info(&self, bucket: &str, path: &str) -> Result<ObjectInfo, Error> {
        let metadata = self.object_metadata(bucket, path).await?;
        let checksum = metadata
            .user_metadata
            .get("ciphertextSha256")
            .and_then(Value::as_str)
            .filter(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
            .ok_or(Error::Api("invalid ciphertext checksum"))?;
        if metadata
            .user_metadata
            .get("formatVersion")
            .and_then(Value::as_u64)
            != Some(1)
        {
            return Err(Error::Api("invalid ciphertext format"));
        }
        Ok(ObjectInfo {
            size_bytes: metadata.size_bytes,
            content_type: metadata.content_type,
            ciphertext_sha256: checksum.into(),
            format_version: 1,
        })
    }

    pub async fn object_sha256(
        &self,
        bucket: &str,
        path: &str,
        expected_size: u64,
    ) -> Result<String, Error> {
        if expected_size == 0 || expected_size > MAX_OBJECT_SIZE {
            return Err(Error::Api("invalid object size"));
        }
        tokio::time::timeout(VERIFICATION_TIMEOUT, async {
            let mut response = self
                .client
                .get_object()
                .bucket(&self.bucket)
                .key(Self::key(bucket, path)?)
                .send()
                .await
                .map_err(|_| Error::Api("read object"))?;
            if response.content_length() != Some(expected_size as i64) {
                return Err(Error::Api("object size mismatch"));
            }
            let mut size = 0_u64;
            let mut digest = Sha256::new();
            while let Some(chunk) = response
                .body
                .try_next()
                .await
                .map_err(|_| Error::Api("read object body"))?
            {
                size = size
                    .checked_add(chunk.len() as u64)
                    .ok_or(Error::Api("object size mismatch"))?;
                if size > expected_size {
                    return Err(Error::Api("object size mismatch"));
                }
                digest.update(chunk);
            }
            if size != expected_size {
                return Err(Error::Api("object size mismatch"));
            }
            Ok(digest
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect())
        })
        .await
        .map_err(|_| Error::Api("verification timed out"))?
    }

    pub async fn delete_file(&self, bucket: &str, path: &str) -> Result<(), Error> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(Self::key(bucket, path)?)
            .send()
            .await
            .map_err(|_| Error::Api("delete object"))?;
        Ok(())
    }

    async fn abort_prefix(
        &self,
        prefix: &str,
        max_uploads: usize,
        should_cancel: &impl Fn() -> bool,
    ) -> Result<(), Error> {
        let mut aborted = 0;
        loop {
            if should_cancel() {
                return Err(Error::Cancelled);
            }
            let response = self
                .client
                .list_multipart_uploads()
                .bucket(&self.bucket)
                .prefix(prefix)
                .max_uploads(1000)
                .send()
                .await
                .map_err(|_| Error::Api("list incomplete uploads"))?;
            if response.uploads().is_empty() {
                return Ok(());
            }
            if aborted + response.uploads().len() > max_uploads {
                return Err(Error::Api("incomplete uploads exceed cleanup limit"));
            }
            for upload in response.uploads() {
                if should_cancel() {
                    return Err(Error::Cancelled);
                }
                let key = upload
                    .key()
                    .filter(|key| key.starts_with(prefix))
                    .ok_or(Error::Api("invalid incomplete upload"))?;
                let id = upload
                    .upload_id()
                    .filter(|id| !id.is_empty())
                    .ok_or(Error::Api("invalid incomplete upload"))?;
                self.client
                    .abort_multipart_upload()
                    .bucket(&self.bucket)
                    .key(key)
                    .upload_id(id)
                    .send()
                    .await
                    .map_err(|_| Error::Api("abort incomplete upload"))?;
                aborted += 1;
            }
        }
    }

    pub async fn clear_prefix(
        &self,
        bucket: &str,
        prefix: &str,
        max_objects: usize,
    ) -> Result<usize, Error> {
        self.clear_prefix_until(bucket, prefix, max_objects, || false)
            .await
    }

    pub async fn clear_prefix_until(
        &self,
        bucket: &str,
        prefix: &str,
        max_objects: usize,
        should_cancel: impl Fn() -> bool,
    ) -> Result<usize, Error> {
        let path = prefix.strip_suffix('/').ok_or(Error::InvalidPath)?;
        let prefix = format!("{}/", Self::key(bucket, path)?);
        if max_objects == 0 {
            return Err(Error::InvalidPath);
        }
        self.abort_prefix(&prefix, max_objects, &should_cancel)
            .await?;
        let mut deleted = 0;
        loop {
            if should_cancel() {
                return Err(Error::Cancelled);
            }
            let response = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&prefix)
                .max_keys(1000)
                .send()
                .await
                .map_err(|_| Error::Api("list objects"))?;
            if response.contents().is_empty() {
                return Ok(deleted);
            }
            if deleted + response.contents().len() > max_objects {
                return Err(Error::Api("prefix exceeds cleanup limit"));
            }
            let objects = response
                .contents()
                .iter()
                .map(|object| {
                    let key = object
                        .key()
                        .filter(|key| key.starts_with(&prefix))
                        .ok_or(Error::Api("invalid listed object"))?;
                    ObjectIdentifier::builder()
                        .key(key)
                        .build()
                        .map_err(|_| Error::Api("invalid listed object"))
                })
                .collect::<Result<Vec<_>, Error>>()?;
            if should_cancel() {
                return Err(Error::Cancelled);
            }
            let response = self
                .client
                .delete_objects()
                .bucket(&self.bucket)
                .delete(
                    Delete::builder()
                        .set_objects(Some(objects))
                        .build()
                        .map_err(|_| Error::Api("invalid delete batch"))?,
                )
                .send()
                .await
                .map_err(|_| Error::Api("delete objects"))?;
            if !response.errors().is_empty() || response.deleted().is_empty() {
                return Err(Error::Api("prefix cleanup incomplete"));
            }
            deleted += response.deleted().len();
        }
    }
}

fn validate_parts(parts: &[Part], expected_size: u64) -> Result<(), Error> {
    if expected_size == 0
        || expected_size > MAX_OBJECT_SIZE
        || parts.len() as u64 != expected_size.div_ceil(PART_SIZE)
    {
        return Err(Error::Api("upload parts do not match reservation"));
    }
    for (index, part) in parts.iter().enumerate() {
        let size = (expected_size - index as u64 * PART_SIZE).min(PART_SIZE);
        if part.number != index as i32 + 1 || part.size != size || part.etag.is_empty() {
            return Err(Error::Api("upload parts do not match reservation"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires R2_TEST_CONFIG for an isolated loopback S3 server"]
    async fn multipart_round_trip_integrity_resume_and_cleanup() {
        let config: Config =
            serde_json::from_str(&std::env::var("R2_TEST_CONFIG").unwrap()).unwrap();
        assert!(config.r2_endpoint.starts_with("http://127.0.0.1:"));
        let storage = Storage::new(&config).unwrap();
        if storage
            .client
            .head_bucket()
            .bucket(&storage.bucket)
            .send()
            .await
            .is_err()
        {
            assert!(
                storage
                    .client
                    .create_bucket()
                    .bucket(&storage.bucket)
                    .send()
                    .await
                    .is_ok()
            );
        }
        let mut bytes = vec![b'x'; PART_SIZE as usize];
        bytes.extend_from_slice(b"last part");
        let digest: String = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let metadata = serde_json::json!({"ciphertextSha256": digest, "formatVersion": 1});
        let bucket = "attachment-backups";
        let key = "user-a/test.anb1";
        let id = storage
            .begin_upload(bucket, key, "application/octet-stream", &metadata)
            .await
            .unwrap();
        let http = reqwest::Client::new();
        for (index, part) in bytes.chunks(PART_SIZE as usize).enumerate() {
            let url = storage
                .upload_part_url(bucket, key, &id, index as i32 + 1, part.len() as u64)
                .await
                .unwrap();
            let response = http.put(url).body(part.to_vec()).send().await;
            assert!(response.is_ok_and(|response| response.status().is_success()));
            let uploaded = storage.list_parts(bucket, key, &id).await.unwrap();
            assert_eq!(uploaded.len(), index + 1);
        }
        assert!(
            storage
                .complete_upload(bucket, key, &id, bytes.len() as u64 + 1)
                .await
                .is_err()
        );
        storage
            .complete_upload(bucket, key, &id, bytes.len() as u64)
            .await
            .unwrap();
        let object = storage.object_info(bucket, key).await.unwrap();
        assert_eq!(object.ciphertext_sha256, digest);
        assert_eq!(object.size_bytes, bytes.len() as u64);
        assert_eq!(
            storage
                .object_sha256(bucket, key, bytes.len() as u64)
                .await
                .unwrap(),
            digest
        );
        assert!(storage.object_sha256(bucket, key, 1).await.is_err());
        let url = storage.create_signed_url(bucket, key, 60).await.unwrap();
        let response = http.get(url).send().await;
        assert!(response.is_ok());
        assert_eq!(response.unwrap().bytes().await.unwrap().as_ref(), bytes);
        assert!(matches!(
            storage
                .clear_prefix_until(bucket, "user-a/", 2, || true)
                .await,
            Err(Error::Cancelled)
        ));
        assert!(storage.clear_prefix(bucket, "user-a", 2).await.is_err());
        assert_eq!(storage.clear_prefix(bucket, "user-a/", 2).await.unwrap(), 1);
        assert_eq!(storage.clear_prefix(bucket, "user-a/", 2).await.unwrap(), 0);
        let id = storage
            .begin_upload(bucket, key, "application/octet-stream", &metadata)
            .await
            .unwrap();
        storage.abort_upload(bucket, key, &id).await.unwrap();
        storage.abort_upload(bucket, key, &id).await.unwrap();
    }

    #[test]
    fn multipart_completion_requires_all_ordered_parts_and_exact_size() {
        let mut parts = vec![
            Part {
                number: 1,
                size: PART_SIZE,
                etag: "first".into(),
            },
            Part {
                number: 2,
                size: 7,
                etag: "last".into(),
            },
        ];
        assert!(validate_parts(&parts, PART_SIZE + 7).is_ok());
        assert!(validate_parts(&parts, PART_SIZE + 8).is_err());
        parts[1].number = 3;
        assert!(validate_parts(&parts, PART_SIZE + 7).is_err());
        assert!(validate_parts(&[], 0).is_err());
        for path in [
            "../other",
            "id/../other",
            "id//file",
            "/id/file",
            "id\\file",
        ] {
            assert!(Storage::key("audio-files", path).is_err());
        }
        assert!(Storage::key("private", "id/file").is_err());
        assert_eq!(
            Storage::key("audio-files", "id/file").unwrap(),
            "audio-files/id/file"
        );
    }
}
