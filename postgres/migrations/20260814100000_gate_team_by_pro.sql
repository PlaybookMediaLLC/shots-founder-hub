CREATE OR REPLACE FUNCTION founder_hub_private.protected_create_workspace(
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
BEGIN
  PERFORM founder_hub_private.require_hyprnote_pro_entitlement();

  RETURN QUERY
  SELECT *
  FROM founder_hub_private.create_workspace(p_name);
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub_private.protected_rename_workspace(
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
BEGIN
  PERFORM founder_hub_private.require_hyprnote_pro_entitlement();

  RETURN QUERY
  SELECT *
  FROM founder_hub_private.rename_workspace(p_workspace_id, p_name);
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub_private.protected_set_workspace_membership_role(
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
BEGIN
  PERFORM founder_hub_private.require_hyprnote_pro_entitlement();

  RETURN QUERY
  SELECT *
  FROM founder_hub_private.set_workspace_membership_role(
    p_workspace_id,
    p_user_id,
    p_role
  );
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub_private.protected_transfer_workspace_ownership(
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
BEGIN
  PERFORM founder_hub_private.require_hyprnote_pro_entitlement();

  RETURN QUERY
  SELECT *
  FROM founder_hub_private.transfer_workspace_ownership(p_workspace_id, p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub_private.protected_create_workspace_invitation(
  p_workspace_id uuid,
  p_invitee_email text
)
RETURNS TABLE (
  invitation_id uuid,
  invite_token text,
  invitation_expires_at timestamptz,
  was_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM founder_hub_private.require_hyprnote_pro_entitlement();

  RETURN QUERY
  SELECT *
  FROM founder_hub_private.create_workspace_invitation(p_workspace_id, p_invitee_email);
END;
$$;

-- Keep invitation acceptance and access-reducing operations available so
-- invited users can join and expired subscribers can leave or clean up a Team.
REVOKE ALL ON FUNCTION founder_hub_private.create_workspace(text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.rename_workspace(uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.set_workspace_membership_role(uuid, uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.transfer_workspace_ownership(uuid, uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.create_workspace_invitation(uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;

REVOKE ALL ON FUNCTION founder_hub_private.protected_create_workspace(text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.protected_rename_workspace(uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.protected_set_workspace_membership_role(
  uuid,
  uuid,
  text
) FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.protected_transfer_workspace_ownership(
  uuid,
  uuid
) FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.protected_create_workspace_invitation(
  uuid,
  text
) FROM PUBLIC, cloud_anonymous, cloud_member;

GRANT EXECUTE ON FUNCTION founder_hub_private.protected_create_workspace(text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.protected_rename_workspace(uuid, text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.protected_set_workspace_membership_role(
  uuid,
  uuid,
  text
) TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.protected_transfer_workspace_ownership(
  uuid,
  uuid
) TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.protected_create_workspace_invitation(
  uuid,
  text
) TO cloud_member;

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
  FROM founder_hub_private.protected_create_workspace(p_name);
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
  FROM founder_hub_private.protected_rename_workspace(p_workspace_id, p_name);
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
  FROM founder_hub_private.protected_set_workspace_membership_role(
    p_workspace_id,
    p_user_id,
    p_role
  );
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
  FROM founder_hub_private.protected_transfer_workspace_ownership(
    p_workspace_id,
    p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION founder_hub.create_workspace_invitation(
  p_workspace_id uuid,
  p_invitee_email text
)
RETURNS TABLE (
  invitation_id uuid,
  invite_token text,
  invitation_expires_at timestamptz,
  was_created boolean
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.protected_create_workspace_invitation(
    p_workspace_id,
    p_invitee_email
  );
$$;
