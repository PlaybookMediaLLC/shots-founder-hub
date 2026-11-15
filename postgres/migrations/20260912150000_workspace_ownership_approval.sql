-- Ownership remains unchanged until the proposed owner explicitly accepts.
CREATE TABLE founder_hub_private.workspace_ownership_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES founder_hub.workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES founder_hub_identity.users(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES founder_hub_identity.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_user_id <> target_user_id)
);
ALTER TABLE founder_hub_private.workspace_ownership_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON founder_hub_private.workspace_ownership_requests FROM PUBLIC, cloud_anonymous, cloud_member;

CREATE OR REPLACE FUNCTION founder_hub_private.transfer_workspace_ownership(
  p_workspace_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  owner_user_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_identity.user_id();
  v_current_owner_id uuid;
  v_target founder_hub.workspace_memberships%ROWTYPE;
BEGIN
  SELECT workspace.owner_user_id
  INTO v_current_owner_id
  FROM founder_hub.workspaces AS workspace
  JOIN founder_hub.workspace_memberships AS membership
    ON membership.workspace_id = workspace.id
  JOIN founder_hub_identity.users AS actor
    ON actor.id = membership.user_id
  WHERE workspace.id = p_workspace_id
    AND workspace.kind = 'shared'
    AND workspace.deleted_at IS NULL
    AND workspace.owner_user_id = v_actor_id
    AND membership.user_id = v_actor_id
    AND membership.role = 'owner'
    AND membership.deleted_at IS NULL
    AND actor.email_confirmed_at IS NOT NULL
    AND COALESCE(actor.is_anonymous, false) = false
  FOR UPDATE OF workspace;

  IF v_current_owner_id IS NULL THEN
    RAISE EXCEPTION 'workspace ownership operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.*
  INTO v_target
  FROM founder_hub.workspace_memberships AS membership
  JOIN founder_hub_identity.users AS target_user
    ON target_user.id = membership.user_id
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = p_user_id
    AND membership.deleted_at IS NULL
    AND target_user.email_confirmed_at IS NOT NULL
    AND COALESCE(target_user.is_anonymous, false) = false
  FOR UPDATE OF membership;

  IF NOT FOUND OR v_target.user_id = v_current_owner_id THEN
    RAISE EXCEPTION 'workspace ownership operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO founder_hub_private.workspace_ownership_requests (workspace_id, owner_user_id, target_user_id)
  VALUES (p_workspace_id, v_current_owner_id, v_target.user_id);

  RETURN QUERY SELECT p_workspace_id, v_current_owner_id;
END;
$$;

CREATE FUNCTION founder_hub.list_workspace_ownership_requests(p_workspace_id uuid)
RETURNS TABLE (id uuid, owner_user_id uuid, target_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT request.id, request.owner_user_id, request.target_user_id
  FROM founder_hub_private.workspace_ownership_requests AS request
  JOIN founder_hub.workspaces AS workspace ON workspace.id = request.workspace_id
  WHERE request.workspace_id = p_workspace_id
    AND workspace.deleted_at IS NULL
    AND workspace.owner_user_id = request.owner_user_id
    AND EXISTS (
      SELECT 1 FROM founder_hub.workspace_memberships AS membership
      JOIN founder_hub_identity.users AS actor ON actor.id = membership.user_id
      WHERE membership.workspace_id = request.workspace_id
        AND membership.user_id = founder_hub_identity.user_id()
        AND membership.deleted_at IS NULL
        AND actor.email_confirmed_at IS NOT NULL
        AND NOT COALESCE(actor.is_anonymous, false)
    );
$$;

CREATE FUNCTION founder_hub.respond_workspace_ownership_request(p_workspace_id uuid, p_request_id uuid, p_action text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_request founder_hub_private.workspace_ownership_requests%ROWTYPE;
  v_owner_id uuid;
BEGIN
  SELECT owner_user_id INTO v_owner_id FROM founder_hub.workspaces
  WHERE id = p_workspace_id AND kind = 'shared' AND deleted_at IS NULL
  FOR UPDATE;
  SELECT * INTO v_request FROM founder_hub_private.workspace_ownership_requests
  WHERE workspace_id = p_workspace_id AND id = p_request_id FOR UPDATE;
  IF v_request.id IS NULL OR v_owner_id IS DISTINCT FROM v_request.owner_user_id
    OR NOT EXISTS (
      SELECT 1 FROM founder_hub.workspace_memberships AS membership
      JOIN founder_hub_identity.users AS actor ON actor.id = membership.user_id
      WHERE membership.workspace_id = p_workspace_id AND membership.user_id = founder_hub_identity.user_id()
        AND membership.deleted_at IS NULL AND actor.email_confirmed_at IS NOT NULL
        AND NOT COALESCE(actor.is_anonymous, false)
    ) THEN
    RAISE EXCEPTION 'ownership request not available' USING ERRCODE = '42501';
  END IF;
  IF p_action = 'cancel' AND founder_hub_identity.user_id() = v_request.owner_user_id THEN
    DELETE FROM founder_hub_private.workspace_ownership_requests WHERE id = v_request.id;
    RETURN;
  END IF;
  IF founder_hub_identity.user_id() <> v_request.target_user_id OR p_action IS NULL OR p_action NOT IN ('accept', 'decline') THEN
    RAISE EXCEPTION 'ownership response not permitted' USING ERRCODE = '42501';
  END IF;
  DELETE FROM founder_hub_private.workspace_ownership_requests WHERE id = v_request.id;
  IF p_action = 'decline' THEN RETURN; END IF;
  PERFORM 1 FROM founder_hub.workspace_memberships
  WHERE workspace_id = p_workspace_id AND user_id IN (v_request.owner_user_id, v_request.target_user_id)
    AND deleted_at IS NULL ORDER BY user_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM founder_hub.workspace_memberships WHERE workspace_id = p_workspace_id
      AND user_id = v_request.owner_user_id AND role = 'owner' AND deleted_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM founder_hub.workspace_memberships WHERE workspace_id = p_workspace_id
      AND user_id = v_request.target_user_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'ownership request not available' USING ERRCODE = '42501';
  END IF;
  UPDATE founder_hub.workspaces SET owner_user_id = v_request.target_user_id, updated_at = now()
  WHERE id = p_workspace_id;
  UPDATE founder_hub.workspace_memberships SET role = 'admin', updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = v_request.owner_user_id;
  UPDATE founder_hub.workspace_memberships SET role = 'owner', updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = v_request.target_user_id;
END;
$$;

-- Removing either party invalidates consent, including a later rejoin.
CREATE FUNCTION founder_hub_private.invalidate_workspace_ownership_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM founder_hub_private.workspace_ownership_requests
    WHERE workspace_id = NEW.workspace_id AND NEW.user_id IN (owner_user_id, target_user_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_workspace_ownership_request
AFTER UPDATE OF deleted_at ON founder_hub.workspace_memberships
FOR EACH ROW EXECUTE FUNCTION founder_hub_private.invalidate_workspace_ownership_request();
REVOKE ALL ON FUNCTION founder_hub_private.invalidate_workspace_ownership_request() FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub.list_workspace_ownership_requests(uuid) FROM PUBLIC, cloud_anonymous;
REVOKE ALL ON FUNCTION founder_hub.respond_workspace_ownership_request(uuid, uuid, text) FROM PUBLIC, cloud_anonymous;
GRANT EXECUTE ON FUNCTION founder_hub.list_workspace_ownership_requests(uuid) TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.respond_workspace_ownership_request(uuid, uuid, text) TO cloud_member;
