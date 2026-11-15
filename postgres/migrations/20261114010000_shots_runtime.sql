CREATE TABLE founder_hub_private.deleted_accounts (
  user_id uuid PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION founder_hub_private.shots_account_available(p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE available boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM founder_hub_private.deleted_accounts WHERE user_id=p_user_id)
    OR EXISTS (SELECT 1 FROM founder_hub_private.account_deletion_jobs WHERE owner_user_id=p_user_id)
  THEN RETURN false; END IF;
  IF to_regprocedure('public.platform_founder_hub_account_available(uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT public.platform_founder_hub_account_available($1)' INTO available USING p_user_id;
    RETURN available;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION founder_hub_private.shots_account_available(uuid) FROM PUBLIC, cloud_anonymous, cloud_member, cloud_service;

GRANT EXECUTE ON FUNCTION founder_hub_private.shots_account_available(uuid) TO cloud_service;
GRANT USAGE ON SCHEMA founder_hub_private TO cloud_service;
CREATE FUNCTION founder_hub.check_shots_request() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT founder_hub_private.check_shots_request()
$$;
REVOKE ALL ON FUNCTION founder_hub.check_shots_request() FROM PUBLIC, cloud_anonymous;
GRANT EXECUTE ON FUNCTION founder_hub.check_shots_request() TO cloud_member;
GRANT EXECUTE ON FUNCTION
  founder_hub_private.resolve_session_share_live_access(uuid, uuid),
  founder_hub_private.read_session_share_live_document(uuid),
  founder_hub_private.read_session_share_live_updates(uuid, bigint, integer),
  founder_hub_private.append_session_share_live_update(uuid, uuid, text, boolean),
  founder_hub_private.compact_session_share_live_document(uuid, text, bigint)
TO cloud_service;

CREATE FUNCTION founder_hub_private.require_shots_account_available() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT founder_hub_private.shots_account_available(NEW.id) THEN
    RAISE EXCEPTION 'Shots account is unavailable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION founder_hub_private.require_shots_account_available() FROM PUBLIC, cloud_anonymous, cloud_member, cloud_service;
CREATE TRIGGER require_shots_account_available BEFORE INSERT OR UPDATE ON founder_hub_identity.users
FOR EACH ROW EXECUTE FUNCTION founder_hub_private.require_shots_account_available();

CREATE FUNCTION founder_hub.purge_shots_account_replica(p_owner_user_id uuid, p_lease_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_workspace_ids uuid[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_user_id::text, 170001));
  SELECT e2ee_workspace_ids INTO v_workspace_ids FROM founder_hub_private.account_deletion_jobs
  WHERE owner_user_id = p_owner_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Validation and the checkpoint roll back together if any replica deletion fails.
  PERFORM founder_hub.mark_account_deletion_e2ee_purged(p_owner_user_id, p_lease_id, v_workspace_ids);
  PERFORM 1 FROM founder_hub.workspaces WHERE id = ANY(v_workspace_ids) ORDER BY id FOR UPDATE;
  DELETE FROM founder_hub.e2ee_replica_receipts WHERE workspace_id = ANY(v_workspace_ids);
  DELETE FROM founder_hub.e2ee_freshness_events WHERE workspace_id = ANY(v_workspace_ids);
  RETURN true;
END;
$$;

CREATE FUNCTION founder_hub.finish_shots_account_deletion(p_owner_user_id uuid, p_lease_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_workspace_ids uuid[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_user_id::text, 170001));
  SELECT e2ee_workspace_ids INTO v_workspace_ids FROM founder_hub_private.account_deletion_jobs
  WHERE owner_user_id = p_owner_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM founder_hub.mark_account_deletion_e2ee_purged(p_owner_user_id, p_lease_id, v_workspace_ids);
  PERFORM 1 FROM founder_hub.workspaces WHERE id = ANY(v_workspace_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM founder_hub.e2ee_replica_receipts WHERE workspace_id = ANY(v_workspace_ids))
    OR EXISTS (SELECT 1 FROM founder_hub.e2ee_freshness_events WHERE workspace_id = ANY(v_workspace_ids)) THEN
    RAISE EXCEPTION 'Shots replica cleanup is incomplete' USING ERRCODE = '55000';
  END IF;
  INSERT INTO founder_hub_private.deleted_accounts(user_id) VALUES(p_owner_user_id) ON CONFLICT DO NOTHING;
  DELETE FROM founder_hub_identity.users WHERE id = p_owner_user_id;
  RETURN founder_hub.finish_account_deletion(p_owner_user_id, p_lease_id);
END;
$$;
REVOKE ALL ON FUNCTION founder_hub.purge_shots_account_replica(uuid, uuid), founder_hub.finish_shots_account_deletion(uuid, uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.purge_shots_account_replica(uuid, uuid), founder_hub.finish_shots_account_deletion(uuid, uuid)
  TO cloud_service;

CREATE OR REPLACE FUNCTION founder_hub.project_shots_authority(p_snapshot jsonb)
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
  v_previous founder_hub_private.shots_workspaces;
BEGIN
  IF v_revision IS NULL OR v_revision < 0 OR v_actor IS NULL OR jsonb_typeof(p_snapshot->'workspaces') <> 'array'
    OR (p_snapshot->>'expiresAt')::timestamptz <= now() THEN
    RAISE EXCEPTION 'Invalid Shots snapshot' USING ERRCODE = '22023';
  END IF;
  -- Roster updates overlap across actors; serialize this short projection transaction.
  PERFORM pg_advisory_xact_lock(716268349103);
  PERFORM founder_hub_private.project_shots_user(p_snapshot, v_revision);
  FOR v_workspace IN SELECT value FROM jsonb_array_elements(p_snapshot->'workspaces') LOOP
    v_workspace_id := (v_workspace->>'workspaceId')::uuid;
    IF v_workspace_id = v_actor OR v_workspace_id = ANY(v_workspaces) THEN
      RAISE EXCEPTION 'Invalid Shots workspace identity' USING ERRCODE = '22023';
    END IF;
    v_workspaces := array_append(v_workspaces, v_workspace_id);
    SELECT * INTO v_previous FROM founder_hub_private.shots_workspaces WHERE workspace_id = v_workspace_id;
    IF v_previous.workspace_id IS NOT NULL THEN
      IF v_previous.shots_organization_id <> v_workspace->>'organizationId' THEN
        RAISE EXCEPTION 'Shots workspace mismatch' USING ERRCODE = '42501';
      END IF;
      IF v_previous.revision > v_revision THEN RAISE EXCEPTION 'Stale Shots authority' USING ERRCODE = '40001'; END IF;
    ELSIF EXISTS (SELECT 1 FROM founder_hub.workspaces WHERE id = v_workspace_id) THEN
      RAISE EXCEPTION 'Existing workspace requires an explicit Shots identity migration' USING ERRCODE = '42501';
    END IF;
    PERFORM founder_hub_private.project_shots_user(v_workspace->'owner', v_revision);
    IF (v_workspace->>'ownerUserId')::uuid <> (v_workspace->'owner'->>'accountUserId')::uuid THEN
      RAISE EXCEPTION 'Invalid Shots workspace owner' USING ERRCODE = '22023';
    END IF;
    INSERT INTO founder_hub.workspaces (id, owner_user_id, kind, name)
    VALUES (v_workspace_id, (v_workspace->>'ownerUserId')::uuid, 'shared', v_workspace->>'name')
    ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id,
      name = EXCLUDED.name, deleted_at = NULL, updated_at = now()
    WHERE founder_hub.workspaces.owner_user_id IS DISTINCT FROM EXCLUDED.owner_user_id
      OR founder_hub.workspaces.name IS DISTINCT FROM EXCLUDED.name OR founder_hub.workspaces.deleted_at IS NOT NULL;
    INSERT INTO founder_hub_private.shots_workspaces (workspace_id, shots_organization_id, features, revision)
    VALUES (v_workspace_id, v_workspace->>'organizationId', v_workspace->'features', v_revision)
    ON CONFLICT (workspace_id) DO UPDATE SET features = EXCLUDED.features, revision = EXCLUDED.revision
    WHERE founder_hub_private.shots_workspaces.features IS DISTINCT FROM EXCLUDED.features OR founder_hub_private.shots_workspaces.revision IS DISTINCT FROM EXCLUDED.revision;
    v_members := ARRAY[]::uuid[];
    v_active_members := ARRAY[]::uuid[];
    FOR v_member IN SELECT value FROM jsonb_array_elements(v_workspace->'members') LOOP
      -- A pre-deletion snapshot may still contain a departing teammate.
      CONTINUE WHEN NOT founder_hub_private.shots_account_available((v_member->>'accountUserId')::uuid);
      PERFORM founder_hub_private.project_shots_user(v_member, v_revision);
      v_member_id := (v_member->>'accountUserId')::uuid;
      SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_permissions FROM jsonb_array_elements_text(v_member->'permissions');
      IF v_member_id = ANY(v_members) THEN RAISE EXCEPTION 'Duplicate Shots member' USING ERRCODE = '22023'; END IF;
      v_members := array_append(v_members, v_member_id);
      INSERT INTO founder_hub_private.shots_memberships (workspace_id, user_id, permissions)
      VALUES (v_workspace_id, v_member_id, v_permissions)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions
      WHERE founder_hub_private.shots_memberships.permissions IS DISTINCT FROM EXCLUDED.permissions;
      IF NOT 'workspace:read' = ANY(v_permissions) THEN CONTINUE; END IF;
      v_active_members := array_append(v_active_members, v_member_id);
      INSERT INTO founder_hub.workspace_memberships (workspace_id, user_id, role)
      VALUES (v_workspace_id, v_member_id, CASE WHEN v_member->>'role' IN ('owner', 'admin') THEN v_member->>'role' ELSE 'member' END)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL, updated_at = now()
      WHERE founder_hub.workspace_memberships.role IS DISTINCT FROM EXCLUDED.role OR founder_hub.workspace_memberships.deleted_at IS NOT NULL;
    END LOOP;
    IF NOT v_actor = ANY(v_members) THEN RAISE EXCEPTION 'Actor missing from Shots roster' USING ERRCODE = '42501'; END IF;
    UPDATE founder_hub.workspace_memberships SET deleted_at = now(), updated_at = now()
    WHERE workspace_id = v_workspace_id AND NOT user_id = ANY(v_active_members) AND deleted_at IS NULL;
    DELETE FROM founder_hub_private.shots_memberships WHERE workspace_id = v_workspace_id AND NOT user_id = ANY(v_members);
  END LOOP;
  UPDATE founder_hub.workspace_memberships SET deleted_at = now(), updated_at = now()
  WHERE user_id = v_actor AND workspace_id IN (SELECT workspace_id FROM founder_hub_private.shots_workspaces)
    AND NOT workspace_id = ANY(v_workspaces) AND deleted_at IS NULL;
  DELETE FROM founder_hub_private.shots_memberships WHERE user_id = v_actor AND NOT workspace_id = ANY(v_workspaces);
END;
$$;
REVOKE ALL ON FUNCTION founder_hub.project_shots_authority(jsonb) FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.project_shots_authority(jsonb) TO cloud_service;

CREATE FUNCTION founder_hub.upsert_nango_connection(
  p_user_id uuid,
  p_integration_id text,
  p_connection_id text,
  p_provider text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF founder_hub_identity.user_id() IS NULL OR founder_hub_identity.user_id() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized to write this Nango connection' USING ERRCODE = '42501';
  END IF;
  IF p_integration_id NOT IN ('hubspot', 'attio', 'salesforce', 'pipedrive', 'close')
    OR p_connection_id IS NULL OR length(p_connection_id) NOT BETWEEN 1 AND 200
    OR p_provider IS NULL OR length(p_provider) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid Nango connection' USING ERRCODE = '22023';
  END IF;
  INSERT INTO founder_hub.nango_connections(user_id, integration_id, connection_id, provider, status)
    VALUES (p_user_id, p_integration_id, p_connection_id, p_provider, 'connected')
  ON CONFLICT (integration_id, connection_id) DO UPDATE SET
    provider = EXCLUDED.provider,
    status = 'connected',
    last_error_type = NULL,
    last_error_description = NULL,
    last_error_at = NULL,
    updated_at = now()
  WHERE founder_hub.nango_connections.user_id = EXCLUDED.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nango connection already belongs to another account' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION founder_hub.delete_nango_connection(
  p_integration_id text,
  p_connection_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF founder_hub_identity.user_id() IS NULL THEN
    RAISE EXCEPTION 'Not authorized to delete Nango connection' USING ERRCODE = '42501';
  END IF;
  DELETE FROM founder_hub.nango_connections
    WHERE user_id = founder_hub_identity.user_id()
      AND integration_id = p_integration_id
      AND connection_id = p_connection_id;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub.upsert_nango_connection(uuid, text, text, text)
  FROM PUBLIC, cloud_anonymous;
GRANT EXECUTE ON FUNCTION founder_hub.upsert_nango_connection(uuid, text, text, text)
  TO cloud_member;
REVOKE ALL ON FUNCTION founder_hub.delete_nango_connection(text, text)
  FROM PUBLIC, cloud_anonymous;
GRANT EXECUTE ON FUNCTION founder_hub.delete_nango_connection(text, text)
  TO cloud_member;

REVOKE ALL ON FUNCTION founder_hub.upsert_nango_connection(uuid, text, text, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.upsert_nango_connection(uuid, text, text, text)
  TO cloud_service;
REVOKE ALL ON FUNCTION founder_hub.delete_nango_connection(text, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.delete_nango_connection(text, text)
  TO cloud_service;

