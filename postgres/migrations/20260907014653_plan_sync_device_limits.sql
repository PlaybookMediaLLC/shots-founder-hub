

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION founder_hub_private.sync_device_limit(p_actor_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM founder_hub.workspace_memberships AS membership
    WHERE membership.user_id = p_actor_user_id
      AND membership.deleted_at IS NULL
      AND founder_hub_private.workspace_capabilities(membership.workspace_id)
        @> ARRAY['team.shared_notes']::text[]
  ) THEN 5 ELSE 3 END;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.sync_device_limit(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.sync_device_limit(uuid) TO cloud_service;

CREATE OR REPLACE FUNCTION founder_hub.get_sync_device_limit(p_actor_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT founder_hub_private.sync_device_limit(p_actor_user_id);
$$;

REVOKE ALL ON FUNCTION founder_hub.get_sync_device_limit(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.get_sync_device_limit(uuid) TO cloud_service;

CREATE OR REPLACE FUNCTION founder_hub.register_e2ee_device_enrollment(
  p_actor_user_id uuid,
  p_device_fingerprint text,
  p_device_name text,
  p_recipient_public_key text,
  p_replace_device_fingerprint text DEFAULT NULL
)
RETURNS TABLE (
  allowed boolean,
  requires_existing_key boolean,
  request_id uuid,
  expires_at timestamptz,
  enrollment_status text,
  ephemeral_public_key text,
  nonce text,
  ciphertext text,
  device_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enrollment founder_hub.e2ee_device_enrollment_requests%ROWTYPE;
  v_max_devices integer := founder_hub_private.sync_device_limit(p_actor_user_id);
  v_reuses_active_slot boolean;
BEGIN
  IF p_actor_user_id IS NULL
    OR p_device_fingerprint IS NULL
    OR p_device_fingerprint !~ '^[A-Za-z0-9_-]{8,128}$'
    OR p_recipient_public_key IS NULL
    OR p_recipient_public_key !~ '^[A-Za-z0-9_-]{43}$'
    OR (
      p_device_name IS NOT NULL
      AND octet_length(NULLIF(TRIM(p_device_name), '')) NOT BETWEEN 1 AND 128
    )
    OR (
      p_replace_device_fingerprint IS NOT NULL
      AND (
        p_replace_device_fingerprint !~ '^[A-Za-z0-9_-]{8,128}$'
        OR p_replace_device_fingerprint = p_device_fingerprint
      )
    )
  THEN
    RAISE EXCEPTION 'E2EE device enrollment is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('sync_devices:' || p_actor_user_id::text, 0));

  DELETE FROM founder_hub.e2ee_device_enrollment_requests AS enrollment
  WHERE enrollment.user_id = p_actor_user_id
    AND enrollment.expires_at <= now();

  IF NOT EXISTS (
    SELECT 1
    FROM founder_hub.workspaces AS workspace
    WHERE workspace.id = p_actor_user_id
      AND workspace.owner_user_id = p_actor_user_id
      AND workspace.kind = 'personal'
      AND workspace.deleted_at IS NULL
      AND workspace.e2ee_key_id IS NOT NULL
  ) THEN
    RETURN QUERY
    SELECT
      false,
      true,
      NULL::uuid,
      NULL::timestamptz,
      NULL::text,
      NULL::text,
      NULL::text,
      NULL::text,
      founder_hub_private.sync_device_slot_count(p_actor_user_id);
    RETURN;
  END IF;

  SELECT enrollment.*
  INTO v_enrollment
  FROM founder_hub.e2ee_device_enrollment_requests AS enrollment
  WHERE enrollment.user_id = p_actor_user_id
    AND enrollment.device_fingerprint = p_device_fingerprint
    AND enrollment.recipient_public_key = p_recipient_public_key
    AND enrollment.expires_at > now()
  FOR UPDATE;

  IF FOUND AND v_enrollment.consumed_at IS NULL THEN
    UPDATE founder_hub.e2ee_device_enrollment_requests AS enrollment
    SET device_name = COALESCE(
      NULLIF(TRIM(p_device_name), ''),
      enrollment.device_name
    )
    WHERE enrollment.id = v_enrollment.id
    RETURNING enrollment.*
    INTO v_enrollment;

    RETURN QUERY
    SELECT
      true,
      false,
      v_enrollment.id,
      v_enrollment.expires_at,
      CASE
        WHEN v_enrollment.consumed_at IS NOT NULL THEN 'consumed'
        WHEN v_enrollment.sealed_at IS NOT NULL THEN 'sealed'
        ELSE 'pending'
      END,
      v_enrollment.ephemeral_public_key,
      v_enrollment.nonce,
      v_enrollment.ciphertext,
      founder_hub_private.sync_device_slot_count(p_actor_user_id);
    RETURN;
  END IF;

  DELETE FROM founder_hub.e2ee_device_enrollment_requests AS enrollment
  WHERE enrollment.user_id = p_actor_user_id
    AND (
      enrollment.device_fingerprint = p_device_fingerprint
      OR enrollment.recipient_public_key = p_recipient_public_key
    );

  SELECT EXISTS (
    SELECT 1
    FROM founder_hub.sync_devices AS device
    WHERE device.user_id = p_actor_user_id
      AND device.device_fingerprint = p_device_fingerprint
  )
  INTO v_reuses_active_slot;

  IF NOT v_reuses_active_slot
    AND founder_hub_private.sync_device_slot_count(p_actor_user_id) = v_max_devices
    AND p_replace_device_fingerprint IS NOT NULL
  THEN
    DELETE FROM founder_hub.sync_devices AS device
    WHERE device.user_id = p_actor_user_id
      AND device.device_fingerprint = p_replace_device_fingerprint;

    DELETE FROM founder_hub.e2ee_device_enrollment_requests AS enrollment
    WHERE enrollment.user_id = p_actor_user_id
      AND enrollment.device_fingerprint = p_replace_device_fingerprint;
  END IF;

  IF NOT v_reuses_active_slot
    AND founder_hub_private.sync_device_slot_count(p_actor_user_id) >= v_max_devices
  THEN
    RETURN QUERY
    SELECT
      false,
      false,
      NULL::uuid,
      NULL::timestamptz,
      NULL::text,
      NULL::text,
      NULL::text,
      NULL::text,
      founder_hub_private.sync_device_slot_count(p_actor_user_id);
    RETURN;
  END IF;

  INSERT INTO founder_hub.e2ee_device_enrollment_requests (
    user_id,
    device_fingerprint,
    device_name,
    recipient_public_key
  )
  VALUES (
    p_actor_user_id,
    p_device_fingerprint,
    NULLIF(TRIM(p_device_name), ''),
    p_recipient_public_key
  )
  RETURNING *
  INTO v_enrollment;

  RETURN QUERY
  SELECT
    true,
    false,
    v_enrollment.id,
    v_enrollment.expires_at,
    'pending'::text,
    NULL::text,
    NULL::text,
    NULL::text,
    founder_hub_private.sync_device_slot_count(p_actor_user_id);
END;
$$;

REVOKE ALL ON FUNCTION founder_hub.register_e2ee_device_enrollment(uuid, text, text, text, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.register_e2ee_device_enrollment(uuid, text, text, text, text)
  TO cloud_service;


CREATE OR REPLACE FUNCTION founder_hub.claim_sync_device(
  p_actor_user_id uuid,
  p_device_fingerprint text,
  p_device_name text DEFAULT NULL
)
RETURNS TABLE (allowed boolean, device_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_max_devices integer := founder_hub_private.sync_device_limit(p_actor_user_id);
  v_claimed boolean;
  v_enrollment_device_name text;
  v_has_enrollment boolean;
BEGIN
  IF p_actor_user_id IS NULL
    OR p_device_fingerprint IS NULL
    OR p_device_fingerprint !~ '^[A-Za-z0-9_-]{8,128}$'
  THEN
    RAISE EXCEPTION 'Sync device identity is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('sync_devices:' || p_actor_user_id::text, 0));

  DELETE FROM founder_hub.e2ee_device_enrollment_requests AS enrollment
  WHERE enrollment.user_id = p_actor_user_id
    AND enrollment.expires_at <= now();

  UPDATE founder_hub.sync_devices AS device
  SET last_seen_at = now(),
      device_name = COALESCE(device.device_name, NULLIF(TRIM(p_device_name), ''))
  WHERE device.user_id = p_actor_user_id
    AND device.device_fingerprint = p_device_fingerprint;
  v_claimed := FOUND;

  SELECT enrollment.device_name
  INTO v_enrollment_device_name
  FROM founder_hub.e2ee_device_enrollment_requests AS enrollment
  WHERE enrollment.user_id = p_actor_user_id
    AND enrollment.device_fingerprint = p_device_fingerprint
    AND enrollment.expires_at > now()
  LIMIT 1;
  v_has_enrollment := FOUND;

  IF NOT v_claimed
    AND (
      v_has_enrollment
      OR founder_hub_private.sync_device_slot_count(p_actor_user_id) < v_max_devices
    )
  THEN
    INSERT INTO founder_hub.sync_devices (user_id, device_fingerprint, device_name)
    VALUES (
      p_actor_user_id,
      p_device_fingerprint,
      COALESCE(
        NULLIF(TRIM(v_enrollment_device_name), ''),
        NULLIF(TRIM(p_device_name), '')
      )
    );
    v_claimed := true;
  END IF;

  IF v_claimed THEN
    DELETE FROM founder_hub.e2ee_device_enrollment_requests AS enrollment
    WHERE enrollment.user_id = p_actor_user_id
      AND enrollment.device_fingerprint = p_device_fingerprint;
  END IF;

  RETURN QUERY
  SELECT
    v_claimed,
    founder_hub_private.sync_device_slot_count(p_actor_user_id);
END;
$$;

REVOKE ALL ON FUNCTION founder_hub.claim_sync_device(uuid, text, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.claim_sync_device(uuid, text, text)
  TO cloud_service;

