ALTER TABLE founder_hub.workspaces
  ADD COLUMN e2ee_key_id text,
  ADD CONSTRAINT workspaces_e2ee_key_id_check CHECK (
    e2ee_key_id IS NULL OR e2ee_key_id ~ '^[A-Za-z0-9_-]{22}$'
  );

CREATE OR REPLACE FUNCTION founder_hub.claim_personal_workspace_e2ee_key(
  p_actor_user_id uuid,
  p_key_id text
)
RETURNS TABLE (key_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_actor_user_id IS NULL
    OR p_key_id IS NULL
    OR p_key_id !~ '^[A-Za-z0-9_-]{22}$'
  THEN
    RAISE EXCEPTION 'E2EE key identity is invalid' USING ERRCODE = '22023';
  END IF;

  UPDATE founder_hub.workspaces AS workspace
  SET e2ee_key_id = p_key_id,
      updated_at = now()
  WHERE workspace.id = p_actor_user_id
    AND workspace.owner_user_id = p_actor_user_id
    AND workspace.kind = 'personal'
    AND workspace.deleted_at IS NULL
    AND workspace.e2ee_key_id IS NULL;

  RETURN QUERY
  SELECT workspace.e2ee_key_id
  FROM founder_hub.workspaces AS workspace
  WHERE workspace.id = p_actor_user_id
    AND workspace.owner_user_id = p_actor_user_id
    AND workspace.kind = 'personal'
    AND workspace.deleted_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub.claim_personal_workspace_e2ee_key(uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.claim_personal_workspace_e2ee_key(uuid, text)
  TO cloud_service;
