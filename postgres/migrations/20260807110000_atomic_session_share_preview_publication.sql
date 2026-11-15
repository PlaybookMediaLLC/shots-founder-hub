CREATE OR REPLACE FUNCTION founder_hub_private.publish_session_share_snapshot_with_preview_cas(
  p_share_id uuid,
  p_actor_user_id uuid,
  p_expected_content_revision bigint,
  p_mutation_id uuid,
  p_title text,
  p_body_json jsonb,
  p_attachment_ids uuid[],
  p_web_editable boolean,
  p_participants text[],
  p_meeting_at timestamptz
)
RETURNS TABLE (
  outcome text,
  share_id uuid,
  schema_version smallint,
  content_revision bigint,
  title text,
  body_json jsonb,
  attachments_json jsonb,
  web_editable boolean,
  access_version bigint,
  published_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_snapshot record;
BEGIN
  SELECT *
  INTO STRICT v_snapshot
  FROM founder_hub_private.publish_session_share_snapshot_cas(
    p_share_id,
    p_actor_user_id,
    p_expected_content_revision,
    p_mutation_id,
    p_title,
    p_body_json,
    p_attachment_ids,
    p_web_editable
  );

  IF v_snapshot.outcome = 'applied' THEN
    PERFORM founder_hub_private.upsert_session_share_preview_metadata(
      p_share_id,
      p_actor_user_id,
      p_participants,
      p_meeting_at
    );
  END IF;

  RETURN QUERY SELECT
    v_snapshot.outcome::text,
    v_snapshot.share_id::uuid,
    v_snapshot.schema_version::smallint,
    v_snapshot.content_revision::bigint,
    v_snapshot.title::text,
    v_snapshot.body_json::jsonb,
    v_snapshot.attachments_json::jsonb,
    v_snapshot.web_editable::boolean,
    v_snapshot.access_version::bigint,
    v_snapshot.published_at::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub.publish_session_share_snapshot_with_preview_cas(
  p_share_id uuid,
  p_actor_user_id uuid,
  p_expected_content_revision bigint,
  p_mutation_id uuid,
  p_title text,
  p_body_json jsonb,
  p_attachment_ids uuid[],
  p_web_editable boolean,
  p_participants text[],
  p_meeting_at timestamptz
)
RETURNS TABLE (
  outcome text,
  share_id uuid,
  schema_version smallint,
  content_revision bigint,
  title text,
  body_json jsonb,
  attachments_json jsonb,
  web_editable boolean,
  access_version bigint,
  published_at timestamptz
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.publish_session_share_snapshot_with_preview_cas(
    p_share_id,
    p_actor_user_id,
    p_expected_content_revision,
    p_mutation_id,
    p_title,
    p_body_json,
    p_attachment_ids,
    p_web_editable,
    p_participants,
    p_meeting_at
  );
$$;

REVOKE ALL ON FUNCTION founder_hub_private.publish_session_share_snapshot_with_preview_cas(
  uuid, uuid, bigint, uuid, text, jsonb, uuid[], boolean, text[], timestamptz
) FROM PUBLIC, cloud_anonymous, cloud_member, cloud_service;
REVOKE ALL ON FUNCTION founder_hub.publish_session_share_snapshot_with_preview_cas(
  uuid, uuid, bigint, uuid, text, jsonb, uuid[], boolean, text[], timestamptz
) FROM PUBLIC, cloud_anonymous, cloud_member, cloud_service;

GRANT EXECUTE ON FUNCTION founder_hub_private.publish_session_share_snapshot_with_preview_cas(
  uuid, uuid, bigint, uuid, text, jsonb, uuid[], boolean, text[], timestamptz
) TO cloud_service;
GRANT EXECUTE ON FUNCTION founder_hub.publish_session_share_snapshot_with_preview_cas(
  uuid, uuid, bigint, uuid, text, jsonb, uuid[], boolean, text[], timestamptz
) TO cloud_service;
