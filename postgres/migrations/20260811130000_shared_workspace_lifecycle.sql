CREATE OR REPLACE FUNCTION founder_hub_private.create_workspace(
  p_name text
)
RETURNS TABLE (
  workspace_id uuid,
  membership_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_identity.user_id();
  v_name text := btrim(p_name);
  v_workspace_id uuid;
  v_membership_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM founder_hub_identity.users AS actor
    WHERE actor.id = v_actor_id
      AND actor.email_confirmed_at IS NOT NULL
      AND COALESCE(actor.is_anonymous, false) = false
  ) THEN
    RAISE EXCEPTION 'workspace operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF v_name IS NULL
    OR char_length(v_name) < 1
    OR char_length(v_name) > 120
    OR v_name ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'invalid workspace name'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(*)
    FROM founder_hub.workspaces AS workspace
    WHERE workspace.owner_user_id = v_actor_id
      AND workspace.kind = 'shared'
      AND workspace.deleted_at IS NULL
  ) >= 20 THEN
    RAISE EXCEPTION 'workspace limit reached'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO founder_hub.workspaces (id, owner_user_id, kind, name)
  VALUES (gen_random_uuid(), v_actor_id, 'shared', v_name)
  RETURNING id INTO v_workspace_id;

  INSERT INTO founder_hub.workspace_memberships (workspace_id, user_id, role)
  VALUES (v_workspace_id, v_actor_id, 'owner')
  RETURNING id INTO v_membership_id;

  RETURN QUERY
  SELECT v_workspace_id, v_membership_id;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub_private.rename_workspace(
  p_workspace_id uuid,
  p_name text
)
RETURNS TABLE (
  workspace_id uuid,
  workspace_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_identity.user_id();
  v_actor_role text;
  v_name text := btrim(p_name);
BEGIN
  SELECT membership.role
  INTO v_actor_role
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
    AND COALESCE(actor.is_anonymous, false) = false
  FOR UPDATE OF workspace;

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'workspace operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF v_name IS NULL
    OR char_length(v_name) < 1
    OR char_length(v_name) > 120
    OR v_name ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'invalid workspace name'
      USING ERRCODE = '22023';
  END IF;

  UPDATE founder_hub.workspaces
  SET
    name = v_name,
    updated_at = now()
  WHERE id = p_workspace_id;

  RETURN QUERY
  SELECT p_workspace_id, v_name;
END;
$$;

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
  v_owner_user_id uuid;
  v_target founder_hub.workspace_memberships%ROWTYPE;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invalid workspace role'
      USING ERRCODE = '22023';
  END IF;

  SELECT workspace.owner_user_id
  INTO v_owner_user_id
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

  IF v_owner_user_id IS NULL THEN
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
    OR v_target.role = 'owner'
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

  UPDATE founder_hub.workspaces
  SET
    owner_user_id = v_target.user_id,
    updated_at = now()
  WHERE id = p_workspace_id;

  UPDATE founder_hub.workspace_memberships
  SET
    role = 'admin',
    updated_at = now()
  WHERE workspace_memberships.workspace_id = p_workspace_id
    AND workspace_memberships.user_id = v_current_owner_id;

  UPDATE founder_hub.workspace_memberships
  SET
    role = 'owner',
    updated_at = now()
  WHERE id = v_target.id;

  RETURN QUERY
  SELECT p_workspace_id, v_target.user_id;
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
BEGIN
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

  IF v_membership.role = 'owner' AND v_membership.deleted_at IS NULL THEN
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

CREATE OR REPLACE FUNCTION founder_hub_private.delete_workspace(
  p_workspace_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  deleted_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_identity.user_id();
  v_owner_user_id uuid;
  v_deleted_at timestamptz := now();
BEGIN
  SELECT workspace.owner_user_id
  INTO v_owner_user_id
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

  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'workspace operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  UPDATE founder_hub.workspace_invitations
  SET
    revoked_by_user_id = v_actor_id,
    revoked_at = v_deleted_at,
    updated_at = v_deleted_at
  WHERE workspace_invitations.workspace_id = p_workspace_id
    AND accepted_at IS NULL
    AND revoked_at IS NULL;

  UPDATE founder_hub.workspaces
  SET
    deleted_at = v_deleted_at,
    updated_at = v_deleted_at
  WHERE id = p_workspace_id;

  RETURN QUERY
  SELECT p_workspace_id, v_deleted_at;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.create_workspace(text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.rename_workspace(uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.set_workspace_membership_role(uuid, uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.transfer_workspace_ownership(uuid, uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.leave_workspace(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.delete_workspace(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;

GRANT EXECUTE ON FUNCTION founder_hub_private.create_workspace(text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.rename_workspace(uuid, text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.set_workspace_membership_role(uuid, uuid, text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.transfer_workspace_ownership(uuid, uuid)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.leave_workspace(uuid)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.delete_workspace(uuid)
  TO cloud_member;

CREATE OR REPLACE FUNCTION founder_hub.create_workspace(
  p_name text
)
RETURNS TABLE (
  workspace_id uuid,
  membership_id uuid
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.create_workspace(p_name);
$$;

CREATE OR REPLACE FUNCTION founder_hub.rename_workspace(
  p_workspace_id uuid,
  p_name text
)
RETURNS TABLE (
  workspace_id uuid,
  workspace_name text
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.rename_workspace(p_workspace_id, p_name);
$$;

CREATE OR REPLACE FUNCTION founder_hub.set_workspace_membership_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role text
)
RETURNS TABLE (
  membership_id uuid,
  membership_role text
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.set_workspace_membership_role(p_workspace_id, p_user_id, p_role);
$$;

CREATE OR REPLACE FUNCTION founder_hub.transfer_workspace_ownership(
  p_workspace_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  owner_user_id uuid
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.transfer_workspace_ownership(p_workspace_id, p_user_id);
$$;

CREATE OR REPLACE FUNCTION founder_hub.leave_workspace(
  p_workspace_id uuid
)
RETURNS TABLE (
  membership_id uuid,
  left_at timestamptz
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.leave_workspace(p_workspace_id);
$$;

CREATE OR REPLACE FUNCTION founder_hub.delete_workspace(
  p_workspace_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  deleted_at timestamptz
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.delete_workspace(p_workspace_id);
$$;

REVOKE ALL ON FUNCTION founder_hub.create_workspace(text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub.rename_workspace(uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub.set_workspace_membership_role(uuid, uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub.transfer_workspace_ownership(uuid, uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub.leave_workspace(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub.delete_workspace(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;

GRANT EXECUTE ON FUNCTION founder_hub.create_workspace(text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.rename_workspace(uuid, text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.set_workspace_membership_role(uuid, uuid, text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.transfer_workspace_ownership(uuid, uuid)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.leave_workspace(uuid)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.delete_workspace(uuid)
  TO cloud_member;
