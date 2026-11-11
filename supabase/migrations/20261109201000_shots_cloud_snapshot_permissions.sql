-- Retain provenance when snapshot content is deleted, so re-upload cannot erase its permission boundary.
CREATE TABLE private.shots_cloud_snapshot_sources (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  workspace_id uuid NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
REVOKE ALL ON private.shots_cloud_snapshot_sources FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.shots_cloud_workspace_allows(p_user_id uuid, p_workspace_id uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_workspace_id = p_user_id OR EXISTS (
    SELECT 1 FROM private.shots_memberships AS membership
    WHERE membership.user_id = p_user_id AND membership.workspace_id = p_workspace_id
      AND 'workspace:read' = ANY(membership.permissions)
      AND p_permission = ANY(membership.permissions)
  );
$$;

CREATE FUNCTION public.publish_shots_cloud_api_snapshot(
  p_actor_user_id uuid, p_session_id text, p_content_json jsonb, p_source_workspace_id uuid
)
RETURNS TABLE (session_id text, revision bigint, published_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_previous uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cloud_api:' || p_actor_user_id::text, 0));
  IF p_source_workspace_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM private.shots_accounts WHERE user_id = p_actor_user_id)
    OR NOT private.shots_cloud_workspace_allows(p_actor_user_id, p_source_workspace_id, 'artifact:read') THEN
    RAISE EXCEPTION 'Shots snapshot permission required' USING ERRCODE = '42501';
  END IF;
  SELECT source.workspace_id INTO v_previous FROM private.shots_cloud_snapshot_sources AS source
    WHERE source.user_id = p_actor_user_id AND source.session_id = btrim(p_session_id);
  -- Moving a note needs permission to read its old source and write its destination.
  IF v_previous IS NOT NULL AND v_previous <> p_source_workspace_id
    AND (NOT private.shots_cloud_workspace_allows(p_actor_user_id, v_previous, 'artifact:read')
      OR NOT private.shots_cloud_workspace_allows(p_actor_user_id, p_source_workspace_id, 'artifact:edit')) THEN
    RAISE EXCEPTION 'Shots snapshot permission required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO private.shots_cloud_snapshot_sources (user_id, session_id, workspace_id)
    VALUES (p_actor_user_id, btrim(p_session_id), p_source_workspace_id)
    ON CONFLICT ON CONSTRAINT shots_cloud_snapshot_sources_pkey DO UPDATE SET workspace_id = EXCLUDED.workspace_id;
  RETURN QUERY SELECT * FROM public.publish_cloud_api_snapshot(p_actor_user_id, p_session_id, p_content_json);
END;
$$;

CREATE FUNCTION private.cloud_snapshot_readable(p_user_id uuid, p_session_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT EXISTS (SELECT 1 FROM private.shots_accounts WHERE user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM private.shots_cloud_snapshot_sources AS source
      WHERE source.user_id = p_user_id AND source.session_id = p_session_id
        AND private.shots_cloud_workspace_allows(p_user_id, source.workspace_id, 'artifact:read'));
$$;

CREATE OR REPLACE FUNCTION public.list_cloud_api_snapshots(
  p_user_id uuid, p_query text DEFAULT NULL, p_series_id text DEFAULT NULL,
  p_limit integer DEFAULT 21, p_offset integer DEFAULT 0
)
RETURNS TABLE (content_json jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT snapshot.content_json FROM public.api_session_snapshots AS snapshot
  WHERE snapshot.user_id = p_user_id
    AND private.cloud_snapshot_readable(p_user_id, snapshot.session_id)
    AND (NULLIF(btrim(p_query), '') IS NULL
      OR strpos(lower(snapshot.title), lower(btrim(p_query))) > 0
      OR strpos(lower(snapshot.session_id), lower(btrim(p_query))) > 0)
    AND (NULLIF(btrim(p_series_id), '') IS NULL OR snapshot.series_id = btrim(p_series_id))
  ORDER BY COALESCE(NULLIF(snapshot.started_at, ''), NULLIF(snapshot.content_json ->> 'created_at', '')) DESC NULLS LAST,
    snapshot.created_at DESC, snapshot.session_id DESC
  LIMIT greatest(1, least(p_limit, 201)) OFFSET greatest(p_offset, 0);
$$;

CREATE OR REPLACE FUNCTION public.read_cloud_api_snapshot(p_user_id uuid, p_session_id text)
RETURNS TABLE (content_json jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT snapshot.content_json FROM public.api_session_snapshots AS snapshot
  WHERE snapshot.user_id = p_user_id AND snapshot.session_id = p_session_id
    AND private.cloud_snapshot_readable(p_user_id, p_session_id);
$$;

REVOKE ALL ON FUNCTION private.shots_cloud_workspace_allows(uuid, uuid, text),
  private.cloud_snapshot_readable(uuid, text), public.publish_shots_cloud_api_snapshot(uuid, text, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_shots_cloud_api_snapshot(uuid, text, jsonb, uuid) TO service_role;
