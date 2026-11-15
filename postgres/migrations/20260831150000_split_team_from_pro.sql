-- Team workspaces have their own workspace-owned subscription. Creating the
-- checkout shell is free; organization-scoped management requires that Team
-- subscription instead of the owner's personal Pro entitlement.

CREATE OR REPLACE FUNCTION founder_hub_private.require_active_team_subscription(
  p_workspace_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM founder_hub.workspaces AS workspace
    JOIN stripe.subscriptions AS subscription
      ON subscription.customer = workspace.stripe_customer_id
    WHERE workspace.id = p_workspace_id
      AND workspace.kind = 'shared'
      AND workspace.deleted_at IS NULL
      AND subscription.status IN ('trialing', 'active')
  ) THEN
    RAISE EXCEPTION 'active Team subscription required'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.require_active_team_subscription(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;

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
DECLARE
  v_workspace_id uuid;
  v_workspace_name text;
BEGIN
  SELECT renamed.workspace_id, renamed.workspace_name
  INTO v_workspace_id, v_workspace_name
  FROM founder_hub_private.rename_workspace(p_workspace_id, p_name) AS renamed;

  PERFORM founder_hub_private.require_active_team_subscription(p_workspace_id);

  RETURN QUERY SELECT v_workspace_id, v_workspace_name;
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
DECLARE
  v_membership_id uuid;
  v_membership_role text;
BEGIN
  SELECT changed.membership_id, changed.membership_role
  INTO v_membership_id, v_membership_role
  FROM founder_hub_private.set_workspace_membership_role(
    p_workspace_id,
    p_user_id,
    p_role
  ) AS changed;

  PERFORM founder_hub_private.require_active_team_subscription(p_workspace_id);

  RETURN QUERY SELECT v_membership_id, v_membership_role;
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
DECLARE
  v_workspace_id uuid;
  v_owner_user_id uuid;
BEGIN
  SELECT transferred.workspace_id, transferred.owner_user_id
  INTO v_workspace_id, v_owner_user_id
  FROM founder_hub_private.transfer_workspace_ownership(
    p_workspace_id,
    p_user_id
  ) AS transferred;

  PERFORM founder_hub_private.require_active_team_subscription(p_workspace_id);

  RETURN QUERY SELECT v_workspace_id, v_owner_user_id;
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
DECLARE
  v_invitation_id uuid;
  v_invite_token text;
  v_invitation_expires_at timestamptz;
  v_was_created boolean;
BEGIN
  SELECT
    invitation.invitation_id,
    invitation.invite_token,
    invitation.invitation_expires_at,
    invitation.was_created
  INTO
    v_invitation_id,
    v_invite_token,
    v_invitation_expires_at,
    v_was_created
  FROM founder_hub_private.create_workspace_invitation(
    p_workspace_id,
    p_invitee_email
  ) AS invitation;

  PERFORM founder_hub_private.require_active_team_subscription(p_workspace_id);

  RETURN QUERY SELECT
    v_invitation_id,
    v_invite_token,
    v_invitation_expires_at,
    v_was_created;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub_private.protected_resend_workspace_invitation(
  p_invitation_id uuid
)
RETURNS TABLE (
  invitation_id uuid,
  invite_token text,
  invitation_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_invitation_id uuid;
  v_invite_token text;
  v_invitation_expires_at timestamptz;
BEGIN
  SELECT invitation.workspace_id
  INTO v_workspace_id
  FROM founder_hub.workspace_invitations AS invitation
  WHERE invitation.id = p_invitation_id;

  SELECT
    resent.invitation_id,
    resent.invite_token,
    resent.invitation_expires_at
  INTO
    v_invitation_id,
    v_invite_token,
    v_invitation_expires_at
  FROM founder_hub_private.resend_workspace_invitation(p_invitation_id) AS resent;

  PERFORM founder_hub_private.require_active_team_subscription(v_workspace_id);

  RETURN QUERY SELECT
    v_invitation_id,
    v_invite_token,
    v_invitation_expires_at;
END;
$$;

COMMENT ON FUNCTION founder_hub_private.require_active_team_subscription(uuid)
IS 'Requires an active workspace-owned Team subscription; personal Pro does not unlock organization controls.';
