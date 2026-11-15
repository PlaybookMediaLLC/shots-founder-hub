-- Additive workspace branding for Team settings.

ALTER TABLE founder_hub.workspaces
ADD COLUMN logo_data text;

ALTER TABLE founder_hub.workspaces
ADD CONSTRAINT workspaces_logo_data_check CHECK (
  logo_data IS NULL
  OR (
    char_length(logo_data) BETWEEN 30 AND 120000
    AND logo_data ~ '^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$'
  )
);

CREATE OR REPLACE FUNCTION founder_hub_private.set_workspace_logo(
  p_workspace_id uuid,
  p_logo_data text
)
RETURNS TABLE (
  workspace_id uuid,
  workspace_logo_data text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_identity.user_id();
  v_actor_role text;
  v_logo_data text := p_logo_data;
BEGIN
  PERFORM founder_hub_private.require_hyprnote_pro_entitlement();

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
    RAISE EXCEPTION 'workspace logo operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF v_logo_data IS NOT NULL THEN
    v_logo_data := btrim(v_logo_data);
    IF char_length(v_logo_data) < 30
      OR char_length(v_logo_data) > 120000
      OR v_logo_data !~ '^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$'
    THEN
      RAISE EXCEPTION 'invalid workspace logo'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE founder_hub.workspaces
  SET
    logo_data = v_logo_data,
    updated_at = now()
  WHERE id = p_workspace_id;

  RETURN QUERY
  SELECT p_workspace_id, v_logo_data;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.set_workspace_logo(uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.set_workspace_logo(uuid, text)
  TO cloud_member;

CREATE OR REPLACE FUNCTION founder_hub.set_workspace_logo(
  p_workspace_id uuid,
  p_logo_data text
)
RETURNS TABLE (
  workspace_id uuid,
  workspace_logo_data text
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.set_workspace_logo(p_workspace_id, p_logo_data);
$$;

REVOKE ALL ON FUNCTION founder_hub.set_workspace_logo(uuid, text)
  FROM PUBLIC, cloud_anonymous;
GRANT EXECUTE ON FUNCTION founder_hub.set_workspace_logo(uuid, text)
  TO cloud_member;
