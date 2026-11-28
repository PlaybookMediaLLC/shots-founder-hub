ALTER TABLE founder_hub.session_share_preview_metadata
  ADD COLUMN event_key text NOT NULL DEFAULT '',
  ADD CONSTRAINT session_share_preview_metadata_event_key_check CHECK (
    char_length(event_key) <= 512
  );

CREATE OR REPLACE FUNCTION founder_hub_private.set_session_share_event_key(
  p_share_id uuid,
  p_actor_user_id uuid,
  p_event_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM founder_hub_private.require_session_share_attachment_manager(
    p_share_id,
    p_actor_user_id
  );

  UPDATE founder_hub.session_share_preview_metadata
  SET event_key = COALESCE(p_event_key, '')
  WHERE share_id = p_share_id;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub.set_session_share_event_key(
  p_share_id uuid,
  p_actor_user_id uuid,
  p_event_key text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT founder_hub_private.set_session_share_event_key(
    p_share_id,
    p_actor_user_id,
    p_event_key
  );
$$;

CREATE OR REPLACE FUNCTION founder_hub.list_my_session_share_event_keys()
RETURNS TABLE (
  share_id uuid,
  event_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT access.share_id, metadata.event_key
  FROM founder_hub_private.list_my_accessible_sessions() AS access
  JOIN founder_hub.session_share_preview_metadata AS metadata
    ON metadata.share_id = access.share_id
  WHERE metadata.event_key <> ''
  ORDER BY access.share_id;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.set_session_share_event_key(uuid, uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member, cloud_service;
REVOKE ALL ON FUNCTION founder_hub.set_session_share_event_key(uuid, uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member, cloud_service;
REVOKE ALL ON FUNCTION founder_hub.list_my_session_share_event_keys()
  FROM PUBLIC, cloud_anonymous, cloud_service;

GRANT EXECUTE ON FUNCTION founder_hub_private.set_session_share_event_key(uuid, uuid, text)
  TO cloud_service;
GRANT EXECUTE ON FUNCTION founder_hub.set_session_share_event_key(uuid, uuid, text)
  TO cloud_service;
GRANT EXECUTE ON FUNCTION founder_hub.list_my_session_share_event_keys()
  TO cloud_member;
