-- Team sharing subdomains live under shots.playbookmedia.io.
CREATE OR REPLACE FUNCTION private.set_workspace_share_slug(
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
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_slug text := lower(btrim(p_slug));
BEGIN
  PERFORM private.require_workspace_capability(
    p_workspace_id,
    'team.custom_subdomain'
  );

  SELECT membership.role
  INTO v_actor_role
  FROM public.workspaces AS workspace
  JOIN public.workspace_memberships AS membership
    ON membership.workspace_id = workspace.id
  JOIN auth.users AS actor
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
      'desktop',
      'dev',
      'docs',
      'mail',
      'models',
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
    UPDATE public.workspaces
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
    format('https://%s.shots.playbookmedia.io', v_slug);
END;
$$;
