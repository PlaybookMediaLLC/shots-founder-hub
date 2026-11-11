CREATE FUNCTION private.shots_allows(p_user_id uuid, p_workspace_id uuid, p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_account private.shots_accounts;
  v_claims jsonb := auth.jwt();
  v_revision bigint;
BEGIN
  SELECT * INTO v_account FROM private.shots_accounts WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN true; END IF;
  IF v_claims->>'role' IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS DISTINCT FROM p_user_id OR COALESCE(v_claims->>'shots_session_id', '') = ''
      OR COALESCE(v_claims->>'shots_revision', '') !~ '^[0-9]+$' THEN RETURN false; END IF;
    v_revision := (v_claims->>'shots_revision')::bigint;
    IF v_revision < v_account.revision OR EXISTS (
      SELECT 1 FROM private.shots_workspaces WHERE workspace_id = p_workspace_id AND revision > v_revision
    ) THEN RAISE EXCEPTION 'Stale Shots authority' USING ERRCODE = '40001'; END IF;
  END IF;
  IF p_workspace_id = p_user_id THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM private.shots_memberships
    WHERE user_id = p_user_id AND workspace_id = p_workspace_id
      AND 'workspace:read' = ANY(permissions) AND p_permission = ANY(permissions)
  );
END;
$$;
REVOKE ALL ON FUNCTION private.shots_allows(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.shots_allows(uuid, uuid, text) TO authenticated, service_role;

-- Central membership caps existing share grants; an outside guest still needs a separate share grant.
CREATE FUNCTION private.shots_share_allows(p_user_id uuid, p_source_workspace_id uuid, p_general_workspace_id uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.shots_allows(p_user_id, p_user_id, 'workspace:read') AND NOT EXISTS (
    SELECT 1 FROM private.shots_workspaces AS workspace
    WHERE workspace.workspace_id = ANY(ARRAY[p_source_workspace_id, p_general_workspace_id])
      AND (
        EXISTS (SELECT 1 FROM private.shots_memberships AS member
          WHERE member.workspace_id = workspace.workspace_id AND member.user_id = p_user_id)
        OR EXISTS (SELECT 1 FROM public.workspace_memberships AS member
          WHERE member.workspace_id = workspace.workspace_id AND member.user_id = p_user_id)
      )
      AND NOT private.shots_allows(p_user_id, workspace.workspace_id, p_permission)
  );
$$;
REVOKE ALL ON FUNCTION private.shots_share_allows(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.shots_share_allows(uuid, uuid, uuid, text) TO authenticated, service_role;

CREATE POLICY shots_workspace_read ON public.workspaces AS RESTRICTIVE FOR SELECT TO authenticated
USING (private.shots_allows((SELECT auth.uid()), id, 'workspace:read'));
CREATE POLICY shots_membership_read ON public.workspace_memberships AS RESTRICTIVE FOR SELECT TO authenticated
USING (private.shots_allows((SELECT auth.uid()), workspace_id, 'workspace:read'));
CREATE POLICY shots_profile_read ON public.profiles AS RESTRICTIVE FOR SELECT TO authenticated
USING (private.shots_allows((SELECT auth.uid()), (SELECT auth.uid()), 'workspace:read'));

CREATE FUNCTION private.require_shots_permission(p_user_id uuid, p_workspace_id uuid, p_permission text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.shots_allows(p_user_id, p_workspace_id, p_permission) THEN
    RAISE EXCEPTION 'Shots workspace permission required' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.require_shots_permission(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.require_shots_permission(uuid, uuid, text) TO service_role;

CREATE FUNCTION private.check_shots_request()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    PERFORM private.require_shots_permission(auth.uid(), auth.uid(), 'workspace:read');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.check_shots_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.check_shots_request() TO anon, authenticated, service_role;
ALTER ROLE authenticator SET pgrst.db_pre_request = 'private.check_shots_request';
NOTIFY pgrst, 'reload config';

CREATE POLICY shots_storage_identity ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
USING (private.shots_allows((SELECT auth.uid()), (SELECT auth.uid()), 'workspace:read'))
WITH CHECK (private.shots_allows((SELECT auth.uid()), (SELECT auth.uid()), 'workspace:read'));

CREATE FUNCTION private.guard_shots_content_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row jsonb;
  v_actor uuid := auth.uid();
  v_workspace uuid;
  v_general_workspace uuid;
BEGIN
  FOR v_row IN SELECT value FROM jsonb_array_elements(
    CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
      WHEN 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
      ELSE jsonb_build_array(to_jsonb(OLD), to_jsonb(NEW)) END
  ) LOOP
    IF TG_TABLE_NAME = 'shared_resources' THEN
      v_workspace := COALESCE((v_row->>'general_workspace_id')::uuid, (v_row->>'owner_user_id')::uuid);
      v_general_workspace := NULL;
    ELSIF TG_TABLE_NAME = 'session_shares' THEN
      v_workspace := (v_row->>'workspace_id')::uuid;
      v_general_workspace := (v_row->>'general_workspace_id')::uuid;
    ELSE
      SELECT workspace_id, general_workspace_id INTO v_workspace, v_general_workspace
      FROM public.session_shares WHERE id = (v_row->>'share_id')::uuid;
    END IF;
    IF TG_TABLE_NAME IN ('session_share_snapshots', 'session_share_live_documents', 'session_share_live_updates') THEN
      IF v_actor IS NULL AND TG_OP <> 'DELETE' THEN
        v_actor := COALESCE((to_jsonb(NEW)->>'actor_user_id')::uuid, (to_jsonb(NEW)->>'published_by_user_id')::uuid);
      END IF;
      IF v_actor IS NOT NULL AND NOT private.shots_share_allows(v_actor, v_workspace, v_general_workspace, 'artifact:edit') THEN
        RAISE EXCEPTION 'Shots workspace permission required' USING ERRCODE = '42501';
      END IF;
    ELSIF v_actor IS NOT NULL THEN
      PERFORM private.require_shots_permission(v_actor, v_workspace, 'artifact:edit');
      IF v_general_workspace IS NOT NULL THEN
        PERFORM private.require_shots_permission(v_actor, v_general_workspace, 'artifact:edit');
      END IF;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.guard_shots_content_write() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER shots_content_write BEFORE INSERT OR UPDATE OR DELETE ON public.session_shares
FOR EACH ROW EXECUTE FUNCTION private.guard_shots_content_write();
CREATE TRIGGER shots_content_write BEFORE INSERT OR UPDATE OR DELETE ON public.session_share_snapshots
FOR EACH ROW EXECUTE FUNCTION private.guard_shots_content_write();
CREATE TRIGGER shots_content_write BEFORE INSERT OR UPDATE OR DELETE ON public.session_share_live_documents
FOR EACH ROW EXECUTE FUNCTION private.guard_shots_content_write();
CREATE TRIGGER shots_content_write BEFORE INSERT OR UPDATE OR DELETE ON public.session_share_live_updates
FOR EACH ROW EXECUTE FUNCTION private.guard_shots_content_write();
CREATE TRIGGER shots_content_write BEFORE INSERT OR UPDATE OR DELETE ON public.shared_resources
FOR EACH ROW EXECUTE FUNCTION private.guard_shots_content_write();


CREATE OR REPLACE FUNCTION private.require_workspace_member(
  p_workspace_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  PERFORM private.require_shots_permission(v_actor_id, p_workspace_id, 'workspace:read');
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'workspace policy operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    JOIN public.workspace_memberships AS membership
      ON membership.workspace_id = workspace.id
    WHERE workspace.id = p_workspace_id
      AND workspace.kind = 'shared'
      AND workspace.deleted_at IS NULL
      AND membership.user_id = v_actor_id
      AND membership.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'workspace policy operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_actor_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.require_workspace_manager(
  p_workspace_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  PERFORM private.require_shots_permission(v_actor_id, p_workspace_id, 'workspace:update');
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'workspace policy operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    JOIN public.workspace_memberships AS membership
      ON membership.workspace_id = workspace.id
    WHERE workspace.id = p_workspace_id
      AND workspace.kind = 'shared'
      AND workspace.deleted_at IS NULL
      AND membership.user_id = v_actor_id
      AND membership.role IN ('owner', 'admin')
      AND membership.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'workspace policy operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_actor_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.require_permanent_user()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT auth_user.id
  INTO v_user_id
  FROM auth.users AS auth_user
  WHERE auth_user.id = auth.uid()
    AND auth_user.email_confirmed_at IS NOT NULL
    AND COALESCE(auth_user.is_anonymous, false) = false
    AND NOT EXISTS (
      SELECT 1
      FROM private.account_deletion_jobs AS deletion
      WHERE deletion.owner_user_id = auth_user.id
    );

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'session access operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  PERFORM private.require_shots_permission(v_user_id, v_user_id, 'workspace:read');
  RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.can_manage_session_share(
  p_workspace_id uuid,
  p_created_by_user_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = p_user_id
      AND private.shots_allows(p_user_id, p_workspace_id, 'artifact:edit')
      AND membership.deleted_at IS NULL
      AND (membership.role IN ('owner','admin') OR p_created_by_user_id = p_user_id)
  );
$$;

CREATE OR REPLACE FUNCTION private.is_session_share_manager(
  p_share_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.session_shares AS share
    JOIN public.workspaces AS workspace ON workspace.id = share.workspace_id
    JOIN public.workspace_memberships AS membership
      ON membership.workspace_id = workspace.id
    JOIN auth.users AS actor ON actor.id = membership.user_id
    WHERE share.id = p_share_id
      AND share.deleted_at IS NULL
      AND workspace.deleted_at IS NULL
      AND membership.user_id = p_user_id
      AND (membership.role IN ('owner', 'admin')
        OR share.created_by_user_id = p_user_id)
      AND private.shots_allows(p_user_id, share.workspace_id, 'artifact:edit')
      AND membership.deleted_at IS NULL
      AND actor.email_confirmed_at IS NOT NULL
      AND COALESCE(actor.is_anonymous, false) = false
  );
$$;

CREATE OR REPLACE FUNCTION private.require_session_share_editor(
  p_share_id uuid,
  p_actor_user_id uuid
)
RETURNS TABLE (manage_access boolean, access_version bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_share public.session_shares%ROWTYPE;
  v_manage_access boolean;
  v_has_editor_grant boolean;
BEGIN
  IF p_share_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'session snapshot edit not permitted'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
  FROM auth.users AS actor
  WHERE actor.id = p_actor_user_id
    AND actor.email_confirmed_at IS NOT NULL
    AND COALESCE(actor.is_anonymous, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM private.account_deletion_jobs AS deletion
      WHERE deletion.owner_user_id = actor.id
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session snapshot edit not permitted'
      USING ERRCODE = '42501';
  END IF;
  SELECT share.* INTO v_share
  FROM public.session_shares AS share
  JOIN public.workspaces AS workspace ON workspace.id = share.workspace_id
  WHERE share.id = p_share_id
    AND share.deleted_at IS NULL
    AND workspace.deleted_at IS NULL
  FOR UPDATE OF share;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session snapshot edit not permitted'
      USING ERRCODE = '42501';
  END IF;
  IF NOT private.shots_share_allows(p_actor_user_id, v_share.workspace_id, v_share.general_workspace_id, 'artifact:edit') THEN
    RAISE EXCEPTION 'Shots workspace permission required' USING ERRCODE = '42501';
  END IF;
  SELECT private.can_manage_session_share(
    v_share.workspace_id, v_share.created_by_user_id, p_actor_user_id
  ) INTO v_manage_access;
  SELECT EXISTS (
    SELECT 1 FROM public.session_access_grants AS access_grant
    WHERE access_grant.share_id = v_share.id
      AND access_grant.grantee_user_id = p_actor_user_id
      AND access_grant.capability = 'editor'
      AND access_grant.revoked_at IS NULL
  ) INTO v_has_editor_grant;
  IF NOT v_manage_access AND NOT v_has_editor_grant THEN
    RAISE EXCEPTION 'session snapshot edit not permitted'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_manage_access, v_share.access_version;
END;
$$;

CREATE OR REPLACE FUNCTION private.require_shared_resource_owner(
  p_share_id uuid
)
RETURNS public.shared_resources
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := private.require_permanent_user();
  v_share public.shared_resources%ROWTYPE;
BEGIN
  SELECT resource.*
  INTO v_share
  FROM public.shared_resources AS resource
  WHERE resource.id = p_share_id
    AND resource.owner_user_id = v_actor_id
    AND resource.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'shared resource operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  PERFORM private.require_shots_permission(v_actor_id, COALESCE(v_share.general_workspace_id, v_actor_id), 'artifact:edit');
  RETURN v_share;
END;
$$;

CREATE OR REPLACE FUNCTION private.resolve_session_share_live_access(
  p_share_id uuid,
  p_actor_user_id uuid
)
RETURNS TABLE (
  share_id uuid,
  capability text,
  access_version bigint,
  content_revision bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_share public.session_shares%ROWTYPE;
  v_snapshot public.session_share_snapshots%ROWTYPE;
  v_manage_access boolean;
  v_has_editor_grant boolean;
  v_has_read_access boolean;
  v_capability text;
BEGIN
  IF p_share_id IS NULL OR p_actor_user_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM auth.users AS actor
  WHERE actor.id = p_actor_user_id
    AND actor.email_confirmed_at IS NOT NULL
    AND COALESCE(actor.is_anonymous, false) = false
    AND NOT EXISTS (
      SELECT 1
      FROM private.account_deletion_jobs AS deletion
      WHERE deletion.owner_user_id = actor.id
    );

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT share.*
  INTO v_share
  FROM public.session_shares AS share
  JOIN public.workspaces AS workspace
    ON workspace.id = share.workspace_id
  WHERE share.id = p_share_id
    AND share.deleted_at IS NULL
    AND workspace.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT private.shots_share_allows(p_actor_user_id, v_share.workspace_id, v_share.general_workspace_id, 'artifact:read') THEN RETURN; END IF;

  SELECT snapshot.*
  INTO v_snapshot
  FROM public.session_share_snapshots AS snapshot
  WHERE snapshot.share_id = v_share.id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_memberships AS membership
    WHERE membership.workspace_id = v_share.workspace_id
      AND membership.user_id = p_actor_user_id
      AND (membership.role IN ('owner', 'admin') OR v_share.created_by_user_id = p_actor_user_id)
      AND membership.deleted_at IS NULL
  )
  INTO v_manage_access;

  SELECT EXISTS (
    SELECT 1
    FROM public.session_access_grants AS access_grant
    WHERE access_grant.share_id = v_share.id
      AND access_grant.grantee_user_id = p_actor_user_id
      AND access_grant.capability = 'editor'
      AND access_grant.revoked_at IS NULL
  )
  INTO v_has_editor_grant;

  IF (v_manage_access OR (v_has_editor_grant AND v_snapshot.web_editable))
    AND private.shots_share_allows(p_actor_user_id, v_share.workspace_id, v_share.general_workspace_id, 'artifact:edit') THEN
    v_capability := 'editor';
  ELSE
    SELECT v_manage_access OR EXISTS (
      SELECT 1
      FROM public.session_access_grants AS access_grant
      WHERE access_grant.share_id = v_share.id
        AND access_grant.grantee_user_id = p_actor_user_id
        AND access_grant.revoked_at IS NULL

      UNION ALL

      SELECT 1
      FROM public.workspace_memberships AS target_membership
      WHERE v_share.general_scope = 'workspace'
        AND target_membership.workspace_id = v_share.general_workspace_id
        AND target_membership.user_id = p_actor_user_id
        AND target_membership.deleted_at IS NULL

      UNION ALL

      SELECT 1
      WHERE v_share.general_scope = 'public'
    )
    INTO v_has_read_access;

    IF NOT v_has_read_access THEN
      RETURN;
    END IF;

    v_capability := 'viewer';
  END IF;

  RETURN QUERY SELECT
    v_share.id,
    v_capability,
    v_share.access_version,
    v_snapshot.content_revision;
END;
$$;

CREATE OR REPLACE FUNCTION private.workspace_capabilities(
  p_workspace_id uuid
)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_features jsonb;
BEGIN
  SELECT features INTO v_features FROM private.shots_workspaces WHERE workspace_id = p_workspace_id;
  IF FOUND THEN
    RETURN CASE WHEN COALESCE((v_features->>'workspace:paid')::boolean, false)
      THEN ARRAY['team.shared_notes', 'team.shared_resources', 'team.manage_workspace', 'team.manage_members']::text[]
      ELSE ARRAY[]::text[] END;
  END IF;
  RETURN (
  WITH paid_features AS (
    SELECT
      COALESCE(bool_or(entitlement.lookup_key IN ('hyprnote_pro', 'hyprnote_team')), false)
        AS has_pro,
      COALESCE(bool_or(entitlement.lookup_key = 'hyprnote_enterprise'), false)
        AS has_enterprise
    FROM public.workspaces AS workspace
    JOIN stripe.subscriptions AS subscription
      ON subscription.customer = workspace.stripe_customer_id
      AND subscription.status IN ('trialing', 'active')
    JOIN stripe.active_entitlements AS entitlement
      ON entitlement.customer = workspace.stripe_customer_id
    WHERE workspace.id = p_workspace_id
      AND workspace.kind = 'shared'
      AND workspace.deleted_at IS NULL
  )
  SELECT CASE
    WHEN paid_features.has_enterprise THEN ARRAY[
      'team.shared_notes',
      'team.shared_resources',
      'team.manage_workspace',
      'team.manage_members',
      'team.manage_policies',
      'team.view_usage',
      'team.custom_subdomain',
      'enterprise.sso',
      'enterprise.scim',
      'enterprise.retention',
      'enterprise.audit_logs',
      'enterprise.capture'
    ]::text[]
    WHEN paid_features.has_pro THEN ARRAY[
      'team.shared_notes',
      'team.shared_resources',
      'team.manage_workspace',
      'team.manage_members'
    ]::text[]
    ELSE ARRAY[]::text[]
  END
  FROM paid_features);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_workspace_members_with_profiles(
  p_workspace_id uuid
)
RETURNS TABLE (
  membership_id uuid,
  user_id uuid,
  user_email text,
  role text,
  created_at timestamptz,
  deleted_at timestamptz,
  user_name text,
  user_avatar_url text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM private.require_shots_permission(auth.uid(), p_workspace_id, 'member:read');
  IF NOT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    JOIN public.workspace_memberships AS membership
      ON membership.workspace_id = workspace.id
    JOIN auth.users AS actor
      ON actor.id = membership.user_id
    WHERE workspace.id = p_workspace_id
      AND workspace.kind = 'shared'
      AND workspace.deleted_at IS NULL
      AND membership.user_id = auth.uid()
      AND membership.deleted_at IS NULL
      AND actor.email_confirmed_at IS NOT NULL
      AND COALESCE(actor.is_anonymous, false) = false
  ) THEN
    RAISE EXCEPTION 'workspace membership operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    membership.id,
    membership.user_id,
    lower(btrim(member_user.email)),
    membership.role,
    membership.created_at,
    membership.deleted_at,
    COALESCE(
      NULLIF(btrim(member_user.raw_user_meta_data ->> 'full_name'), ''),
      NULLIF(btrim(member_user.raw_user_meta_data ->> 'name'), '')
    ),
    CASE WHEN jsonb_typeof(member_user.raw_user_meta_data -> 'profile_avatar') = 'object'
      AND (member_user.raw_user_meta_data -> 'profile_avatar') ? 'url'
    THEN NULLIF(btrim(member_user.raw_user_meta_data #>> '{profile_avatar,url}'), '')
    ELSE COALESCE(
      NULLIF(btrim(member_user.raw_user_meta_data ->> 'avatar_url'), ''),
      NULLIF(btrim(member_user.raw_user_meta_data ->> 'picture'), '')
    ) END
  FROM public.workspace_memberships AS membership
  LEFT JOIN auth.users AS member_user
    ON member_user.id = membership.user_id
  WHERE membership.workspace_id = p_workspace_id
    AND membership.deleted_at IS NULL
  ORDER BY membership.created_at, membership.id;
END;
$$;


CREATE OR REPLACE FUNCTION private.require_session_share_attachment_manager(
  p_share_id uuid,
  p_actor_user_id uuid
)
RETURNS public.session_shares
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_share public.session_shares%ROWTYPE;
BEGIN
  IF p_share_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'session attachment operation not permitted'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
  FROM auth.users AS actor
  WHERE actor.id = p_actor_user_id
    AND actor.email_confirmed_at IS NOT NULL
    AND COALESCE(actor.is_anonymous, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM private.account_deletion_jobs AS deletion
      WHERE deletion.owner_user_id = actor.id
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session attachment operation not permitted'
      USING ERRCODE = '42501';
  END IF;
  SELECT share.* INTO v_share
  FROM public.session_shares AS share
  JOIN public.workspaces AS workspace ON workspace.id = share.workspace_id
  JOIN public.workspace_memberships AS membership
    ON membership.workspace_id = workspace.id
  WHERE share.id = p_share_id
    AND share.deleted_at IS NULL
    AND workspace.deleted_at IS NULL
    AND membership.user_id = p_actor_user_id
    AND membership.deleted_at IS NULL
    AND private.can_manage_session_share(
      share.workspace_id, share.created_by_user_id, p_actor_user_id
    )
  FOR UPDATE OF share, workspace, membership;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session attachment operation not permitted'
      USING ERRCODE = '42501';
  END IF;
  PERFORM private.require_shots_permission(p_actor_user_id, v_share.workspace_id, 'artifact:edit');
  IF v_share.general_workspace_id IS NOT NULL THEN
    PERFORM private.require_shots_permission(p_actor_user_id, v_share.general_workspace_id, 'artifact:edit');
  END IF;
  RETURN v_share;
END;
$$;

CREATE OR REPLACE FUNCTION private.prepare_my_session_share_attachment_download(
  p_share_id uuid,
  p_attachment_id uuid,
  p_actor_user_id uuid,
  p_download_expires_at timestamptz
)
RETURNS TABLE (
  share_id uuid,
  attachment_id uuid,
  object_key text,
  filename text,
  content_type text,
  size_bytes bigint,
  sha256 text,
  access_version bigint,
  cleanup_not_before timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.session_shares AS share
  WHERE share.id = p_share_id FOR SHARE OF share;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1
  FROM auth.users AS actor
  WHERE actor.id = p_actor_user_id
    AND actor.email_confirmed_at IS NOT NULL
    AND COALESCE(actor.is_anonymous, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM private.account_deletion_jobs AS deletion
      WHERE deletion.owner_user_id = actor.id
    );
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1
  FROM public.session_shares AS share
  JOIN public.workspaces AS source_workspace
    ON source_workspace.id = share.workspace_id
  WHERE share.id = p_share_id
    AND share.deleted_at IS NULL
    AND source_workspace.deleted_at IS NULL
    AND private.shots_share_allows(p_actor_user_id, share.workspace_id, share.general_workspace_id, 'artifact:read')
    AND (
      private.can_manage_session_share(
        share.workspace_id, share.created_by_user_id, p_actor_user_id
      )
      OR EXISTS (
        SELECT 1 FROM public.session_access_grants AS access_grant
        WHERE access_grant.share_id = share.id
          AND access_grant.grantee_user_id = p_actor_user_id
          AND access_grant.revoked_at IS NULL
      )
      OR (
        share.general_scope = 'workspace'
        AND EXISTS (
          SELECT 1
          FROM public.workspaces AS target_workspace
          JOIN public.workspace_memberships AS target_membership
            ON target_membership.workspace_id = target_workspace.id
          WHERE target_workspace.id = share.general_workspace_id
            AND target_workspace.deleted_at IS NULL
            AND target_membership.user_id = p_actor_user_id
            AND target_membership.deleted_at IS NULL
        )
      )
      OR share.general_scope = 'public'
    );
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT *
  FROM private.prepare_session_share_attachment_download(
    p_share_id, p_attachment_id, p_download_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.list_workspace_key_recipients(
  p_workspace_id uuid
)
RETURNS TABLE (
  user_id uuid,
  user_email text,
  role text,
  public_key text,
  granted_key_ids text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM private.require_shots_permission(auth.uid(), p_workspace_id, 'member:read');
  PERFORM private.require_shots_permission(auth.uid(), p_workspace_id, 'identity:manage');
  IF NOT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    JOIN public.workspace_memberships AS membership
      ON membership.workspace_id = workspace.id
    JOIN auth.users AS actor
      ON actor.id = membership.user_id
    WHERE workspace.id = p_workspace_id
      AND workspace.kind = 'shared'
      AND workspace.deleted_at IS NULL
      AND membership.user_id = auth.uid()
      AND membership.role IN ('owner', 'admin')
      AND membership.deleted_at IS NULL
      AND actor.email_confirmed_at IS NOT NULL
      AND COALESCE(actor.is_anonymous, false) = false
  ) THEN
    RAISE EXCEPTION 'E2EE key operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    membership.user_id,
    lower(btrim(member_user.email)),
    membership.role,
    identity.public_key,
    COALESCE(
      (
        SELECT array_agg(grant_row.key_id ORDER BY grant_row.key_id)
        FROM public.workspace_e2ee_key_grants AS grant_row
        WHERE grant_row.workspace_id = p_workspace_id
          AND grant_row.member_user_id = membership.user_id
      ),
      ARRAY[]::text[]
    )
  FROM public.workspace_memberships AS membership
  JOIN auth.users AS member_user
    ON member_user.id = membership.user_id
  LEFT JOIN public.e2ee_member_identities AS identity
    ON identity.user_id = membership.user_id
  WHERE membership.workspace_id = p_workspace_id
    AND membership.deleted_at IS NULL
  ORDER BY membership.created_at, membership.id;
END;
$$;

CREATE OR REPLACE FUNCTION private.set_workspace_e2ee_key(
  p_workspace_id uuid,
  p_key_id text,
  p_grants jsonb
)
RETURNS TABLE (
  out_key_id text,
  out_granted_member_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_grant jsonb;
  v_member_id uuid;
  v_granted integer := 0;
BEGIN
  PERFORM private.require_shots_permission(auth.uid(), p_workspace_id, 'identity:manage');
  IF NOT EXISTS (
    SELECT 1
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
  ) THEN
    RAISE EXCEPTION 'E2EE key operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF p_key_id IS NULL OR p_key_id !~ '^[A-Za-z0-9_-]{22}$' THEN
    RAISE EXCEPTION 'E2EE key identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_grants IS NULL OR jsonb_typeof(p_grants) <> 'array' THEN
    RAISE EXCEPTION 'E2EE key grants are invalid'
      USING ERRCODE = '22023';
  END IF;

  -- The issuer must keep their own access, otherwise a rotation could lock the
  -- workspace out of its own data.
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_grants) AS candidate
    WHERE (candidate ->> 'userId')::uuid = v_actor_id
  ) THEN
    RAISE EXCEPTION 'E2EE key grants must include the issuing member'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.workspaces AS workspace
  WHERE workspace.id = p_workspace_id
  FOR UPDATE;

  UPDATE public.workspace_e2ee_keys
  SET retired_at = now()
  WHERE workspace_e2ee_keys.workspace_id = p_workspace_id
    AND workspace_e2ee_keys.key_id <> p_key_id
    AND workspace_e2ee_keys.retired_at IS NULL;

  INSERT INTO public.workspace_e2ee_keys (workspace_id, key_id, created_by_user_id)
  VALUES (p_workspace_id, p_key_id, v_actor_id)
  ON CONFLICT (workspace_id, key_id) DO UPDATE SET retired_at = NULL;

  FOR v_grant IN SELECT * FROM jsonb_array_elements(p_grants)
  LOOP
    BEGIN
      v_member_id := (v_grant ->> 'userId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'E2EE key grants are invalid'
        USING ERRCODE = '22023';
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM public.workspace_memberships AS membership
      WHERE membership.workspace_id = p_workspace_id
        AND membership.user_id = v_member_id
        AND membership.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'E2EE key grants must target active members'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.workspace_e2ee_key_grants (
      workspace_id,
      key_id,
      member_user_id,
      ephemeral_public_key,
      nonce,
      ciphertext,
      issued_by_user_id
    ) VALUES (
      p_workspace_id,
      p_key_id,
      v_member_id,
      v_grant ->> 'ephemeralPublicKey',
      v_grant ->> 'nonce',
      v_grant ->> 'ciphertext',
      v_actor_id
    )
    ON CONFLICT (workspace_id, key_id, member_user_id) DO NOTHING;
  END LOOP;

  SELECT count(*)
  INTO v_granted
  FROM public.workspace_e2ee_key_grants AS grant_row
  WHERE grant_row.workspace_id = p_workspace_id
    AND grant_row.key_id = p_key_id;

  RETURN QUERY
  SELECT p_key_id, v_granted;
END;
$$;


CREATE OR REPLACE FUNCTION private.resolve_my_session_access(
  p_share_id uuid
)
RETURNS TABLE (
  share_id uuid,
  workspace_id uuid,
  session_id text,
  capability text,
  manage_access boolean,
  access_version bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := private.require_permanent_user();
BEGIN
  RETURN QUERY
  WITH access_candidates AS (
    SELECT 3 AS capability_rank, true AS can_manage
    FROM public.session_shares AS candidate_share
    JOIN public.workspaces AS source_workspace
      ON source_workspace.id = candidate_share.workspace_id
    JOIN public.workspace_memberships AS source_membership
      ON source_membership.workspace_id = source_workspace.id
    WHERE candidate_share.id = p_share_id
      AND candidate_share.deleted_at IS NULL
      AND source_workspace.deleted_at IS NULL
      AND source_membership.user_id = v_actor_id
      AND source_membership.deleted_at IS NULL
      AND (source_membership.role IN ('owner', 'admin') OR candidate_share.created_by_user_id = v_actor_id)
    UNION ALL
    SELECT private.session_capability_rank(access_grant.capability), false
    FROM public.session_access_grants AS access_grant
    WHERE access_grant.share_id = p_share_id
      AND access_grant.grantee_user_id = v_actor_id
      AND access_grant.revoked_at IS NULL
    UNION ALL
    SELECT 1, false
    FROM public.session_shares AS candidate_share
    JOIN public.workspaces AS target_workspace
      ON target_workspace.id = candidate_share.general_workspace_id
    JOIN public.workspace_memberships AS target_membership
      ON target_membership.workspace_id = target_workspace.id
    WHERE candidate_share.id = p_share_id
      AND candidate_share.general_scope = 'workspace'
      AND candidate_share.deleted_at IS NULL
      AND target_workspace.deleted_at IS NULL
      AND target_membership.user_id = v_actor_id
      AND target_membership.deleted_at IS NULL
    UNION ALL
    SELECT 1, false
    FROM public.session_shares AS candidate_share
    WHERE candidate_share.id = p_share_id
      AND candidate_share.general_scope = 'public'
      AND candidate_share.deleted_at IS NULL
  ), effective_access AS (
    SELECT max(capability_rank) AS capability_rank,
      bool_or(can_manage) AS can_manage
    FROM access_candidates
  )
  SELECT share.id, share.workspace_id, share.session_id,
    CASE WHEN NOT private.shots_share_allows(v_actor_id, share.workspace_id, share.general_workspace_id, 'artifact:edit') THEN 'viewer'
      ELSE CASE effective_access.capability_rank
        WHEN 1 THEN 'viewer' WHEN 2 THEN 'commenter' WHEN 3 THEN 'editor'
      END
    END,
    effective_access.can_manage AND private.shots_share_allows(v_actor_id, share.workspace_id, share.general_workspace_id, 'artifact:edit'), share.access_version
  FROM public.session_shares AS share
  JOIN public.workspaces AS source_workspace
    ON source_workspace.id = share.workspace_id
  CROSS JOIN effective_access
  WHERE share.id = p_share_id
    AND share.deleted_at IS NULL
    AND source_workspace.deleted_at IS NULL
    AND effective_access.capability_rank IS NOT NULL
    AND private.shots_share_allows(v_actor_id, share.workspace_id, share.general_workspace_id, 'artifact:read');
END;
$$;

CREATE OR REPLACE FUNCTION private.list_my_accessible_sessions()
RETURNS TABLE (
  share_id uuid,
  workspace_id uuid,
  session_id text,
  capability text,
  manage_access boolean,
  access_version bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := private.require_permanent_user();
BEGIN
  RETURN QUERY
  WITH access_candidates AS (
    SELECT share.id AS candidate_share_id, 3 AS capability_rank,
      true AS can_manage
    FROM public.session_shares AS share
    JOIN public.workspaces AS source_workspace
      ON source_workspace.id = share.workspace_id
    JOIN public.workspace_memberships AS source_membership
      ON source_membership.workspace_id = source_workspace.id
    WHERE share.deleted_at IS NULL
      AND source_workspace.deleted_at IS NULL
      AND source_membership.user_id = v_actor_id
      AND source_membership.deleted_at IS NULL
      AND (source_membership.role IN ('owner', 'admin') OR share.created_by_user_id = v_actor_id)
    UNION ALL
    SELECT access_grant.share_id,
      private.session_capability_rank(access_grant.capability), false
    FROM public.session_access_grants AS access_grant
    JOIN public.session_shares AS share ON share.id = access_grant.share_id
    WHERE access_grant.grantee_user_id = v_actor_id
      AND access_grant.revoked_at IS NULL
      AND share.deleted_at IS NULL
    UNION ALL
    SELECT share.id, 1, false
    FROM public.session_shares AS share
    JOIN public.workspaces AS target_workspace
      ON target_workspace.id = share.general_workspace_id
    JOIN public.workspace_memberships AS target_membership
      ON target_membership.workspace_id = target_workspace.id
    WHERE share.general_scope = 'workspace'
      AND share.deleted_at IS NULL
      AND target_workspace.deleted_at IS NULL
      AND target_membership.user_id = v_actor_id
      AND target_membership.deleted_at IS NULL
  ), effective_access AS (
    SELECT candidate_share_id, max(capability_rank) AS capability_rank,
      bool_or(can_manage) AS can_manage
    FROM access_candidates
    GROUP BY candidate_share_id
  )
  SELECT share.id, share.workspace_id, share.session_id,
    CASE WHEN NOT private.shots_share_allows(v_actor_id, share.workspace_id, share.general_workspace_id, 'artifact:edit') THEN 'viewer'
      ELSE CASE effective_access.capability_rank
        WHEN 1 THEN 'viewer' WHEN 2 THEN 'commenter' WHEN 3 THEN 'editor'
      END
    END,
    effective_access.can_manage AND private.shots_share_allows(v_actor_id, share.workspace_id, share.general_workspace_id, 'artifact:edit'), share.access_version
  FROM effective_access
  JOIN public.session_shares AS share
    ON share.id = effective_access.candidate_share_id
  JOIN public.workspaces AS source_workspace
    ON source_workspace.id = share.workspace_id
  WHERE share.deleted_at IS NULL AND source_workspace.deleted_at IS NULL
    AND private.shots_share_allows(v_actor_id, share.workspace_id, share.general_workspace_id, 'artifact:read')
  ORDER BY share.updated_at DESC, share.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_shared_resources(
  p_resource_type text
)
RETURNS TABLE (
  share_id uuid,
  resource_type text,
  source_id text,
  resource_title text,
  payload jsonb,
  owner_user_id uuid,
  owner_email text,
  general_workspace_id uuid,
  workspace_name text,
  access_kind text,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := private.require_permanent_user();
  v_actor_email text;
  v_type text := lower(btrim(COALESCE(p_resource_type, '')));
BEGIN
  IF v_type NOT IN ('folder', 'template', 'automation') THEN
    RAISE EXCEPTION 'invalid shared resource type' USING ERRCODE = '22023';
  END IF;

  SELECT lower(btrim(account.email))
  INTO v_actor_email
  FROM auth.users AS account
  WHERE account.id = v_actor_id
    AND account.email_confirmed_at IS NOT NULL;

  IF v_actor_email IS NULL THEN
    RAISE EXCEPTION 'permanent user required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    resource.id,
    resource.resource_type,
    resource.source_id,
    resource.title,
    resource.payload,
    resource.owner_user_id,
    lower(btrim(owner_account.email)),
    resource.general_workspace_id,
    workspace.name,
    CASE
      WHEN resource.owner_user_id = v_actor_id THEN 'owner'
      WHEN membership.id IS NOT NULL
        AND private.workspace_has_capability(
          resource.general_workspace_id,
          'team.shared_resources'
        )
      THEN 'team'
      ELSE 'guest'
    END,
    resource.updated_at
  FROM public.shared_resources AS resource
  JOIN auth.users AS owner_account
    ON owner_account.id = resource.owner_user_id
  LEFT JOIN public.workspaces AS workspace
    ON workspace.id = resource.general_workspace_id
    AND workspace.kind = 'shared'
    AND workspace.deleted_at IS NULL
  LEFT JOIN public.workspace_memberships AS membership
    ON membership.workspace_id = resource.general_workspace_id
    AND membership.user_id = v_actor_id
    AND membership.deleted_at IS NULL
  LEFT JOIN public.shared_resource_guests AS guest
    ON guest.share_id = resource.id
    AND guest.invitee_email = v_actor_email
    AND guest.revoked_at IS NULL
  WHERE resource.resource_type = v_type
    AND resource.deleted_at IS NULL
    AND private.shots_share_allows(v_actor_id, resource.owner_user_id, resource.general_workspace_id, 'artifact:read')
    AND (
      resource.owner_user_id = v_actor_id
      OR (
        membership.id IS NOT NULL
        AND private.workspace_has_capability(
          resource.general_workspace_id,
          'team.shared_resources'
        )
      )
      OR (
        guest.id IS NOT NULL
        AND (
          resource.general_workspace_id IS NULL
          OR private.workspace_has_capability(
            resource.general_workspace_id,
            'team.shared_resources'
          )
        )
      )
    )
  ORDER BY resource.updated_at DESC, resource.id;
END;
$$;

CREATE OR REPLACE FUNCTION private.list_session_share_comments(
  p_share_id uuid,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_comment_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  comment_id uuid,
  is_author boolean,
  snapshot_content_revision bigint,
  body text,
  anchor_quote_exact text,
  anchor_quote_prefix text,
  anchor_quote_suffix text,
  anchor_from_hint bigint,
  anchor_to_hint bigint,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := private.require_permanent_user();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 101);
BEGIN
  IF (p_before_created_at IS NULL) <> (p_before_comment_id IS NULL) THEN
    RAISE EXCEPTION 'invalid session comment cursor'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
      SELECT 1 FROM public.session_shares AS share
      JOIN public.workspaces AS workspace ON workspace.id = share.workspace_id
      JOIN public.workspace_memberships AS member ON member.workspace_id = share.workspace_id
      WHERE share.id = p_share_id AND share.deleted_at IS NULL AND workspace.deleted_at IS NULL
        AND member.user_id = v_actor_id AND member.deleted_at IS NULL
        AND (member.role IN ('owner', 'admin') OR share.created_by_user_id = v_actor_id)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.session_access_grants AS access_grant
      JOIN public.session_shares AS share
        ON share.id = access_grant.share_id
      JOIN public.workspaces AS workspace
        ON workspace.id = share.workspace_id
      WHERE access_grant.share_id = p_share_id
        AND access_grant.grantee_user_id = v_actor_id
        AND access_grant.capability IN ('viewer', 'commenter', 'editor')
        AND access_grant.revoked_at IS NULL
        AND share.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'session comment operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.session_shares AS share WHERE share.id = p_share_id
      AND private.shots_share_allows(v_actor_id, share.workspace_id, share.general_workspace_id, 'artifact:read')
  ) THEN
    RAISE EXCEPTION 'session comment operation not permitted' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    comment.id,
    comment.author_user_id = v_actor_id,
    comment.snapshot_content_revision,
    comment.body,
    comment.anchor_quote_exact,
    comment.anchor_quote_prefix,
    comment.anchor_quote_suffix,
    comment.anchor_from_hint,
    comment.anchor_to_hint,
    comment.created_at
  FROM public.session_share_comments AS comment
  WHERE comment.share_id = p_share_id
    AND comment.deleted_at IS NULL
    AND (
      p_before_created_at IS NULL
      OR (comment.created_at, comment.id)
        < (p_before_created_at, p_before_comment_id)
    )
  ORDER BY comment.created_at DESC, comment.id DESC
  LIMIT v_limit;
END;
$$;

CREATE OR REPLACE FUNCTION private.list_all_my_workspace_e2ee_grants()
RETURNS TABLE (
  workspace_id uuid,
  key_id text,
  ephemeral_public_key text,
  nonce text,
  ciphertext text,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM auth.users AS actor
    WHERE actor.id = v_actor_id
      AND actor.email_confirmed_at IS NOT NULL
      AND COALESCE(actor.is_anonymous, false) = false
  ) THEN
    RAISE EXCEPTION 'E2EE key operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    grant_row.workspace_id,
    grant_row.key_id,
    grant_row.ephemeral_public_key,
    grant_row.nonce,
    grant_row.ciphertext,
    workspace_key.retired_at IS NULL,
    grant_row.created_at
  FROM public.workspace_e2ee_key_grants AS grant_row
  JOIN public.workspace_e2ee_keys AS workspace_key
    ON workspace_key.workspace_id = grant_row.workspace_id
    AND workspace_key.key_id = grant_row.key_id
  JOIN public.workspace_memberships AS membership
    ON membership.workspace_id = grant_row.workspace_id
    AND membership.user_id = grant_row.member_user_id
    AND membership.deleted_at IS NULL
  JOIN public.workspaces AS workspace
    ON workspace.id = grant_row.workspace_id
    AND workspace.kind = 'shared'
    AND workspace.deleted_at IS NULL
  WHERE grant_row.member_user_id = v_actor_id
    AND private.shots_allows(v_actor_id, grant_row.workspace_id, 'artifact:read')
  ORDER BY grant_row.workspace_id, workspace_key.created_at, grant_row.created_at;
END;
$$;


CREATE OR REPLACE FUNCTION private.list_my_workspace_e2ee_grants(
  p_workspace_id uuid
)
RETURNS TABLE (
  key_id text,
  ephemeral_public_key text,
  nonce text,
  ciphertext text,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    JOIN public.workspace_memberships AS membership
      ON membership.workspace_id = workspace.id
    WHERE workspace.id = p_workspace_id
      AND workspace.deleted_at IS NULL
      AND membership.user_id = auth.uid()
      AND membership.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'E2EE key operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    grant_row.key_id,
    grant_row.ephemeral_public_key,
    grant_row.nonce,
    grant_row.ciphertext,
    workspace_key.retired_at IS NULL,
    grant_row.created_at
  FROM public.workspace_e2ee_key_grants AS grant_row
  JOIN public.workspace_e2ee_keys AS workspace_key
    ON workspace_key.workspace_id = grant_row.workspace_id
    AND workspace_key.key_id = grant_row.key_id
  WHERE grant_row.workspace_id = p_workspace_id
    AND grant_row.member_user_id = auth.uid()
    AND private.shots_allows(auth.uid(), p_workspace_id, 'artifact:read')
  ORDER BY workspace_key.created_at, grant_row.created_at;
END;
$$;

