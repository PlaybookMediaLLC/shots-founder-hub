-- Additive workspace branding for enterprise sharing links.

ALTER TABLE founder_hub.workspaces
ADD COLUMN share_slug text;

ALTER TABLE founder_hub.workspaces
ADD CONSTRAINT workspaces_share_slug_check CHECK (
  share_slug IS NULL
  OR (
    share_slug = lower(share_slug)
    AND share_slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
    AND share_slug NOT IN (
      'admin',
      'api',
      'app',
      'assets',
      'auth',
      'cdn',
      'dev',
      'docs',
      'mail',
      'staging',
      'static',
      'status',
      'support',
      'www'
    )
  )
);

CREATE UNIQUE INDEX workspaces_share_slug_key
  ON founder_hub.workspaces(share_slug)
  WHERE share_slug IS NOT NULL;

CREATE OR REPLACE FUNCTION founder_hub_private.set_workspace_share_slug(
  p_workspace_id uuid,
  p_slug text
)
RETURNS TABLE (
  workspace_id uuid,
  workspace_share_slug text,
  share_base_url text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_identity.user_id();
  v_actor_role text;
  v_slug text := lower(btrim(p_slug));
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
    RAISE EXCEPTION 'workspace subdomain operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF v_slug IS NULL
    OR v_slug !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
    OR v_slug IN (
      'admin',
      'api',
      'app',
      'assets',
      'auth',
      'cdn',
      'dev',
      'docs',
      'mail',
      'staging',
      'static',
      'status',
      'support',
      'www'
    )
  THEN
    RAISE EXCEPTION 'invalid workspace subdomain'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    UPDATE founder_hub.workspaces
    SET
      share_slug = v_slug,
      updated_at = now()
    WHERE id = p_workspace_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'workspace subdomain is already taken'
        USING ERRCODE = '23505';
  END;

  RETURN QUERY
  SELECT
    p_workspace_id,
    v_slug,
    format('https://%s.anarlog.so', v_slug);
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub_private.get_session_share_workspace_slug(
  p_share_id uuid
)
RETURNS TABLE (
  workspace_share_slug text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := founder_hub_private.require_permanent_user();
BEGIN
  IF NOT founder_hub_private.is_session_share_manager(p_share_id, v_actor_id) THEN
    RAISE EXCEPTION 'session access operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT workspace.share_slug
  FROM founder_hub.session_shares AS share
  JOIN founder_hub.workspaces AS workspace
    ON workspace.id = share.workspace_id
  WHERE share.id = p_share_id
    AND share.deleted_at IS NULL
    AND workspace.deleted_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.set_workspace_share_slug(uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON FUNCTION founder_hub_private.get_session_share_workspace_slug(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.set_workspace_share_slug(uuid, text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.get_session_share_workspace_slug(uuid)
  TO cloud_member;

CREATE OR REPLACE FUNCTION founder_hub.set_workspace_share_slug(
  p_workspace_id uuid,
  p_slug text
)
RETURNS TABLE (
  workspace_id uuid,
  workspace_share_slug text,
  share_base_url text
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.set_workspace_share_slug(p_workspace_id, p_slug);
$$;

CREATE OR REPLACE FUNCTION founder_hub.get_session_share_workspace_slug(
  p_share_id uuid
)
RETURNS TABLE (
  workspace_share_slug text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM founder_hub_private.get_session_share_workspace_slug(p_share_id);
$$;

REVOKE ALL ON FUNCTION founder_hub.set_workspace_share_slug(uuid, text)
  FROM PUBLIC, cloud_anonymous;
REVOKE ALL ON FUNCTION founder_hub.get_session_share_workspace_slug(uuid)
  FROM PUBLIC, cloud_anonymous;
GRANT EXECUTE ON FUNCTION founder_hub.set_workspace_share_slug(uuid, text)
  TO cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.get_session_share_workspace_slug(uuid)
  TO cloud_member;
