CREATE TABLE private.shots_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  shots_user_id text NOT NULL UNIQUE,
  revision bigint NOT NULL CHECK (revision >= 0)
);
CREATE TABLE private.shots_workspaces (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  shots_organization_id text NOT NULL UNIQUE,
  features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
  revision bigint NOT NULL CHECK (revision >= 0)
);
CREATE TABLE private.shots_memberships (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permissions text[] NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
REVOKE ALL ON private.shots_accounts, private.shots_workspaces, private.shots_memberships
  FROM PUBLIC, anon, authenticated;

-- Shots identities must never acquire legacy billing or memberships by matching email.
DROP TRIGGER on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW
WHEN (NEW.raw_app_meta_data->>'provider' IS DISTINCT FROM 'shots')
EXECUTE FUNCTION public.handle_new_user();
DROP TRIGGER on_auth_user_email_updated ON auth.users;
CREATE TRIGGER on_auth_user_email_updated AFTER UPDATE OF email ON auth.users FOR EACH ROW
WHEN (NEW.raw_app_meta_data->>'provider' IS DISTINCT FROM 'shots')
EXECUTE FUNCTION public.handle_user_email_update();
DROP TRIGGER on_auth_user_email_auto_join ON auth.users;
CREATE TRIGGER on_auth_user_email_auto_join
AFTER INSERT OR UPDATE OF email, email_confirmed_at, is_anonymous, last_sign_in_at ON auth.users
FOR EACH ROW WHEN (NEW.raw_app_meta_data->>'provider' IS DISTINCT FROM 'shots')
EXECUTE FUNCTION private.auto_join_email_workspace();
DROP TRIGGER on_auth_user_domain_capture ON auth.users;
CREATE TRIGGER on_auth_user_domain_capture AFTER INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW WHEN (NEW.raw_app_meta_data->>'provider' IS DISTINCT FROM 'shots')
EXECUTE FUNCTION private.capture_user_into_verified_domain_workspace();

CREATE OR REPLACE FUNCTION private.handle_account_onboarding_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  confirmation_time timestamptz;
  display_name text;
  first_name text;
BEGIN
  IF NEW.raw_app_meta_data->>'provider' = 'shots' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.is_anonymous, false)
    OR NULLIF(btrim(NEW.email), '') IS NULL
  THEN
    RETURN NEW;
  END IF;

  confirmation_time := COALESCE(
    NEW.confirmed_at,
    NEW.email_confirmed_at,
    NEW.phone_confirmed_at
  );
  IF confirmation_time IS NULL THEN
    RETURN NEW;
  END IF;

  display_name := COALESCE(
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'given_name'), ''),
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'name'), '')
  );
  first_name := COALESCE(
    split_part(regexp_replace(display_name, '\s+', ' ', 'g'), ' ', 1),
    'there'
  );

  INSERT INTO private.account_onboarding_outbox (
    user_id,
    email,
    first_name,
    occurred_at
  )
  VALUES (
    NEW.id,
    btrim(NEW.email),
    first_name,
    confirmation_time
  )
  ON CONFLICT (user_id) DO UPDATE SET
    email = EXCLUDED.email,
    first_name = EXCLUDED.first_name,
    occurred_at = EXCLUDED.occurred_at,
    updated_at = clock_timestamp()
  WHERE private.account_onboarding_outbox.delivered_at IS NULL;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_account_analytics_event(
  p_event_name text,
  p_user_id uuid,
  p_occurred_at timestamptz,
  p_email text,
  p_auth_provider text,
  p_historical boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  person_properties jsonb;
BEGIN
  IF p_auth_provider = 'shots' THEN RETURN; END IF;
  IF p_event_name NOT IN ('account_created', 'account_confirmed')
    OR p_user_id IS NULL
    OR p_occurred_at IS NULL
  THEN
    RAISE EXCEPTION 'invalid account analytics event'
      USING ERRCODE = '22023';
  END IF;

  person_properties := jsonb_strip_nulls(
    jsonb_build_object(
      'email',
      p_email,
      CASE
        WHEN p_event_name = 'account_created' THEN 'account_created_at'
        ELSE 'account_confirmed_at'
      END,
      p_occurred_at
    )
  );

  INSERT INTO private.account_analytics_outbox (
    event_name,
    user_id,
    occurred_at,
    email,
    properties,
    historical
  )
  VALUES (
    p_event_name,
    p_user_id,
    p_occurred_at,
    p_email,
    jsonb_strip_nulls(
      jsonb_build_object(
        'source',
        'supabase_auth',
        'auth_provider',
        p_auth_provider,
        '$set',
        person_properties
      )
    ),
    p_historical
  )
  ON CONFLICT (event_name, user_id) DO NOTHING;
END;
$$;

CREATE FUNCTION private.project_shots_user(p_identity jsonb, p_revision bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid := (p_identity->>'accountUserId')::uuid;
  v_shots_id text := p_identity->'user'->>'id';
  v_previous private.shots_accounts;
BEGIN
  SELECT * INTO v_previous FROM private.shots_accounts WHERE user_id = v_id;
  IF v_previous.user_id IS NOT NULL THEN
    IF v_previous.shots_user_id <> v_shots_id THEN RAISE EXCEPTION 'Shots identity mismatch' USING ERRCODE = '42501'; END IF;
    IF v_previous.revision > p_revision THEN RAISE EXCEPTION 'Stale Shots authority' USING ERRCODE = '40001'; END IF;
  ELSIF EXISTS (SELECT 1 FROM auth.users WHERE id = v_id) THEN
    RAISE EXCEPTION 'Existing library requires an explicit Shots identity migration' USING ERRCODE = '42501';
  END IF;
  INSERT INTO auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, is_anonymous, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_id, 'authenticated', 'authenticated', p_identity->'user'->>'email',
    CASE WHEN (p_identity->>'emailVerified')::boolean THEN now() ELSE NULL END,
    (p_identity->>'createdAt')::timestamptz, now(), false,
    jsonb_build_object('provider', 'shots', 'providers', jsonb_build_array('shots'), 'shots_user_id', v_shots_id),
    jsonb_build_object('name', p_identity->'user'->>'name', 'full_name', p_identity->'user'->>'name', 'avatar_url', p_identity->'user'->'image'))
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email,
    email_confirmed_at = CASE WHEN EXCLUDED.email_confirmed_at IS NOT NULL THEN COALESCE(auth.users.email_confirmed_at, EXCLUDED.email_confirmed_at) ELSE NULL END, raw_user_meta_data = EXCLUDED.raw_user_meta_data,
    raw_app_meta_data = EXCLUDED.raw_app_meta_data, updated_at = now()
  WHERE auth.users.email IS DISTINCT FROM EXCLUDED.email
    OR (auth.users.email_confirmed_at IS NOT NULL) IS DISTINCT FROM (EXCLUDED.email_confirmed_at IS NOT NULL)
    OR auth.users.raw_user_meta_data IS DISTINCT FROM EXCLUDED.raw_user_meta_data
    OR auth.users.raw_app_meta_data IS DISTINCT FROM EXCLUDED.raw_app_meta_data;
  INSERT INTO public.profiles (id) VALUES (v_id) ON CONFLICT (id) DO NOTHING;
  INSERT INTO private.shots_accounts (user_id, shots_user_id, revision)
  VALUES (v_id, v_shots_id, p_revision) ON CONFLICT (user_id) DO UPDATE SET revision = EXCLUDED.revision
  WHERE private.shots_accounts.revision IS DISTINCT FROM EXCLUDED.revision;
END;
$$;
REVOKE ALL ON FUNCTION private.project_shots_user(jsonb, bigint) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.project_shots_authority(p_snapshot jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_revision bigint := (p_snapshot->>'revision')::bigint;
  v_actor uuid := (p_snapshot->>'accountUserId')::uuid;
  v_workspace jsonb;
  v_member jsonb;
  v_workspace_id uuid;
  v_member_id uuid;
  v_permissions text[];
  v_members uuid[];
  v_active_members uuid[];
  v_workspaces uuid[] := ARRAY[]::uuid[];
  v_previous private.shots_workspaces;
BEGIN
  IF v_revision IS NULL OR v_revision < 0 OR v_actor IS NULL OR jsonb_typeof(p_snapshot->'workspaces') <> 'array'
    OR (p_snapshot->>'expiresAt')::timestamptz <= now() THEN
    RAISE EXCEPTION 'Invalid Shots snapshot' USING ERRCODE = '22023';
  END IF;
  -- Roster updates overlap across actors; serialize this short projection transaction.
  PERFORM pg_advisory_xact_lock(716268349103);
  PERFORM private.project_shots_user(p_snapshot, v_revision);
  FOR v_workspace IN SELECT value FROM jsonb_array_elements(p_snapshot->'workspaces') LOOP
    v_workspace_id := (v_workspace->>'workspaceId')::uuid;
    IF v_workspace_id = v_actor OR v_workspace_id = ANY(v_workspaces) THEN
      RAISE EXCEPTION 'Invalid Shots workspace identity' USING ERRCODE = '22023';
    END IF;
    v_workspaces := array_append(v_workspaces, v_workspace_id);
    SELECT * INTO v_previous FROM private.shots_workspaces WHERE workspace_id = v_workspace_id;
    IF v_previous.workspace_id IS NOT NULL THEN
      IF v_previous.shots_organization_id <> v_workspace->>'organizationId' THEN
        RAISE EXCEPTION 'Shots workspace mismatch' USING ERRCODE = '42501';
      END IF;
      IF v_previous.revision > v_revision THEN RAISE EXCEPTION 'Stale Shots authority' USING ERRCODE = '40001'; END IF;
    ELSIF EXISTS (SELECT 1 FROM public.workspaces WHERE id = v_workspace_id) THEN
      RAISE EXCEPTION 'Existing workspace requires an explicit Shots identity migration' USING ERRCODE = '42501';
    END IF;
    PERFORM private.project_shots_user(v_workspace->'owner', v_revision);
    IF (v_workspace->>'ownerUserId')::uuid <> (v_workspace->'owner'->>'accountUserId')::uuid THEN
      RAISE EXCEPTION 'Invalid Shots workspace owner' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.workspaces (id, owner_user_id, kind, name)
    VALUES (v_workspace_id, (v_workspace->>'ownerUserId')::uuid, 'shared', v_workspace->>'name')
    ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id,
      name = EXCLUDED.name, deleted_at = NULL, updated_at = now()
    WHERE public.workspaces.owner_user_id IS DISTINCT FROM EXCLUDED.owner_user_id
      OR public.workspaces.name IS DISTINCT FROM EXCLUDED.name OR public.workspaces.deleted_at IS NOT NULL;
    INSERT INTO private.shots_workspaces (workspace_id, shots_organization_id, features, revision)
    VALUES (v_workspace_id, v_workspace->>'organizationId', v_workspace->'features', v_revision)
    ON CONFLICT (workspace_id) DO UPDATE SET features = EXCLUDED.features, revision = EXCLUDED.revision
    WHERE private.shots_workspaces.features IS DISTINCT FROM EXCLUDED.features OR private.shots_workspaces.revision IS DISTINCT FROM EXCLUDED.revision;
    v_members := ARRAY[]::uuid[];
    v_active_members := ARRAY[]::uuid[];
    FOR v_member IN SELECT value FROM jsonb_array_elements(v_workspace->'members') LOOP
      PERFORM private.project_shots_user(v_member, v_revision);
      v_member_id := (v_member->>'accountUserId')::uuid;
      SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_permissions FROM jsonb_array_elements_text(v_member->'permissions');
      IF v_member_id = ANY(v_members) THEN RAISE EXCEPTION 'Duplicate Shots member' USING ERRCODE = '22023'; END IF;
      v_members := array_append(v_members, v_member_id);
      INSERT INTO private.shots_memberships (workspace_id, user_id, permissions)
      VALUES (v_workspace_id, v_member_id, v_permissions)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions
      WHERE private.shots_memberships.permissions IS DISTINCT FROM EXCLUDED.permissions;
      IF NOT 'workspace:read' = ANY(v_permissions) THEN CONTINUE; END IF;
      v_active_members := array_append(v_active_members, v_member_id);
      INSERT INTO public.workspace_memberships (workspace_id, user_id, role)
      VALUES (v_workspace_id, v_member_id, CASE WHEN v_member->>'role' IN ('owner', 'admin') THEN v_member->>'role' ELSE 'member' END)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL, updated_at = now()
      WHERE public.workspace_memberships.role IS DISTINCT FROM EXCLUDED.role OR public.workspace_memberships.deleted_at IS NOT NULL;
    END LOOP;
    IF NOT v_actor = ANY(v_members) THEN RAISE EXCEPTION 'Actor missing from Shots roster' USING ERRCODE = '42501'; END IF;
    UPDATE public.workspace_memberships SET deleted_at = now(), updated_at = now()
    WHERE workspace_id = v_workspace_id AND NOT user_id = ANY(v_active_members) AND deleted_at IS NULL;
    DELETE FROM private.shots_memberships WHERE workspace_id = v_workspace_id AND NOT user_id = ANY(v_members);
  END LOOP;
  UPDATE public.workspace_memberships SET deleted_at = now(), updated_at = now()
  WHERE user_id = v_actor AND workspace_id IN (SELECT workspace_id FROM private.shots_workspaces)
    AND NOT workspace_id = ANY(v_workspaces) AND deleted_at IS NULL;
  DELETE FROM private.shots_memberships WHERE user_id = v_actor AND NOT workspace_id = ANY(v_workspaces);
END;
$$;
REVOKE ALL ON FUNCTION public.project_shots_authority(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_shots_authority(jsonb) TO service_role;
