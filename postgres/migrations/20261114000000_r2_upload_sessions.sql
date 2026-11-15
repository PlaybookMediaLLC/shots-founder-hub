CREATE TABLE founder_hub_private.file_uploads (
  id uuid PRIMARY KEY,
  bucket text NOT NULL CHECK (bucket IN ('audio-files', 'attachment-backups', 'shared-note-attachments', 'profile-avatars')),
  object_key text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES founder_hub_identity.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  upload_id text NOT NULL,
  content_type text NOT NULL,
  metadata jsonb NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 545259520),
  status text NOT NULL CHECK (status IN ('active', 'complete', 'aborted')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key)
);
REVOKE ALL ON founder_hub_private.file_uploads FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT SELECT, INSERT, UPDATE, DELETE ON founder_hub_private.file_uploads TO cloud_service;
