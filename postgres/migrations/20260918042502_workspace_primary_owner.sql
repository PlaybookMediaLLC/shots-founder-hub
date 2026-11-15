-- owner_user_id identifies the single Primary owner; owner memberships may be shared.
-- Serialize membership changes with primary transfers so the primary cannot leave
-- or be demoted while another request is changing ownership.

CREATE OR REPLACE FUNCTION founder_hub_private.set_workspace_membership_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role text
)
RETURNS TABLE (
  membership_id uuid,
  membership_role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_identity.user_id();
  v_actor_role text;
  v_owner_user_id uuid;
  v_target founder_hub.workspace_memberships%ROWTYPE;
BEGIN
  PERFORM 1 FROM founder_hub.workspaces
  WHERE id = p_workspace_id AND kind = 'shared' AND deleted_at IS NULL
  FOR UPDATE;

  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'invalid workspace role'
      USING ERRCODE = '22023';
  END IF;

  SELECT workspace.owner_user_id, membership.role
  INTO v_owner_user_id, v_actor_role
  FROM founder_hub.workspaces AS workspace
  JOIN founder_hub.workspace_memberships AS membership
    ON membership.workspace_id = workspace.id
  JOIN founder_hub_identity.users AS actor
    ON actor.id = membership.user_id
  WHERE workspace.id = p_workspace_id
    AND workspace.kind = 'shared'
    AND workspace.deleted_at IS NULL
    AND membership.user_id = v_actor_id
    AND membership.role IN ('owner', 'admin')
    AND membership.deleted_at IS NULL
    AND actor.email_confirmed_at IS NOT NULL
    AND COALESCE(actor.is_anonymous, false) = false;

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'workspace membership operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.*
  INTO v_target
  FROM founder_hub.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_target.deleted_at IS NOT NULL
    OR v_target.user_id = v_owner_user_id
    OR (v_target.role = 'owner' AND v_actor_id <> v_owner_user_id AND v_target.user_id <> v_actor_id)
  THEN
    RAISE EXCEPTION 'workspace membership operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  -- Admins may raise a member to admin and nothing else: demoting an admin
  -- (including themselves) stays an owner decision.
  IF v_actor_role = 'admin'
    AND NOT (v_target.role = 'member' AND p_role = 'admin')
  THEN
    RAISE EXCEPTION 'workspace membership operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF v_target.role <> p_role THEN
    UPDATE founder_hub.workspace_memberships
    SET
      role = p_role,
      updated_at = now()
    WHERE id = v_target.id;
  END IF;

  RETURN QUERY
  SELECT v_target.id, p_role;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub_private.revoke_workspace_membership(
  p_workspace_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  membership_id uuid,
  revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_identity.user_id();
  v_actor_role text;
  v_owner_user_id uuid;
  v_target founder_hub.workspace_memberships%ROWTYPE;
  v_revoked_at timestamptz;
BEGIN
  PERFORM 1 FROM founder_hub.workspaces
  WHERE id = p_workspace_id AND kind = 'shared' AND deleted_at IS NULL
  FOR UPDATE;

  SELECT workspace.owner_user_id, membership.role
  INTO v_owner_user_id, v_actor_role
  FROM founder_hub.workspaces AS workspace
  JOIN founder_hub.workspace_memberships AS membership
    ON membership.workspace_id = workspace.id
  JOIN founder_hub_identity.users AS actor
    ON actor.id = membership.user_id
  WHERE workspace.id = p_workspace_id
    AND workspace.kind = 'shared'
    AND workspace.deleted_at IS NULL
    AND membership.user_id = v_actor_id
    AND membership.role IN ('owner', 'admin')
    AND membership.deleted_at IS NULL
    AND actor.email_confirmed_at IS NOT NULL
    AND COALESCE(actor.is_anonymous, false) = false;

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'workspace membership operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.*
  INTO v_target
  FROM founder_hub.workspace_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_target.user_id = v_owner_user_id
    OR (v_target.role = 'owner' AND v_actor_id <> v_owner_user_id)
    OR (v_actor_role = 'admin' AND v_target.role <> 'member')
  THEN
    RAISE EXCEPTION 'workspace membership operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF v_target.deleted_at IS NULL THEN
    v_revoked_at := now();

    UPDATE founder_hub.workspace_memberships
    SET
      deleted_at = v_revoked_at,
      updated_at = v_revoked_at
    WHERE id = v_target.id;
  ELSE
    v_revoked_at := v_target.deleted_at;
  END IF;

  RETURN QUERY
  SELECT v_target.id, v_revoked_at;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub_private.leave_workspace(
  p_workspace_id uuid
)
RETURNS TABLE (
  membership_id uuid,
  left_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_identity.user_id();
  v_membership founder_hub.workspace_memberships%ROWTYPE;
  v_left_at timestamptz;
  v_owner_user_id uuid;
BEGIN
  SELECT owner_user_id INTO v_owner_user_id FROM founder_hub.workspaces
  WHERE id = p_workspace_id AND kind = 'shared' AND deleted_at IS NULL
  FOR UPDATE;

  SELECT membership.*
  INTO v_membership
  FROM founder_hub.workspace_memberships AS membership
  JOIN founder_hub.workspaces AS workspace
    ON workspace.id = membership.workspace_id
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = v_actor_id
    AND workspace.kind = 'shared'
    AND workspace.deleted_at IS NULL
  FOR UPDATE OF membership;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace membership operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor_id = v_owner_user_id AND v_membership.deleted_at IS NULL THEN
    RAISE EXCEPTION 'owner must transfer ownership before leaving'
      USING ERRCODE = '22023';
  END IF;

  IF v_membership.deleted_at IS NULL THEN
    v_left_at := now();

    UPDATE founder_hub.workspace_memberships
    SET
      deleted_at = v_left_at,
      updated_at = v_left_at
    WHERE id = v_membership.id;
  ELSE
    v_left_at := v_membership.deleted_at;
  END IF;

  RETURN QUERY
  SELECT v_membership.id, v_left_at;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub.respond_workspace_ownership_request(p_workspace_id uuid, p_request_id uuid, p_action text)
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
  UPDATE founder_hub.workspace_memberships SET role = 'owner', updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = v_request.target_user_id;
END;
$$;
