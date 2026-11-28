

CREATE FUNCTION founder_hub_private.admit_e2ee_witness_write()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  -- A fixed database budget also covers API replicas and older service callers.
  FOR slot IN 1..4 LOOP
    IF pg_catalog.pg_try_advisory_xact_lock(17469, slot) THEN
      RETURN;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Encrypted sync is busy; retry later' USING ERRCODE = '55P03';
END;
$$;
REVOKE ALL ON FUNCTION founder_hub_private.admit_e2ee_witness_write() FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.admit_e2ee_witness_write() TO cloud_service;

CREATE OR REPLACE FUNCTION founder_hub.publish_e2ee_freshness_events(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_initialize boolean,
  p_events jsonb
)
RETURNS TABLE (
  initialized_at timestamptz,
  head_sequence bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_active_key_id text;
  v_initialized_at timestamptz;
  v_workspace_kind text;
  v_events jsonb := COALESCE(p_events, '[]'::jsonb);
BEGIN
  IF p_actor_user_id IS NULL OR p_workspace_id IS NULL OR p_initialize IS NULL THEN
    RAISE EXCEPTION 'E2EE freshness request is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM founder_hub_private.admit_e2ee_witness_write();
  SELECT workspace.e2ee_freshness_initialized_at, workspace.kind::text
  INTO v_initialized_at, v_workspace_kind
  FROM founder_hub.workspaces AS workspace
  WHERE workspace.id = p_workspace_id
  FOR UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'E2EE freshness publication is not permitted' USING ERRCODE = '42501';
  END IF;

  SELECT founder_hub_private.active_e2ee_freshness_key_id(p_actor_user_id, p_workspace_id)
  INTO v_active_key_id;

  IF v_active_key_id IS NULL THEN
    RAISE EXCEPTION 'E2EE freshness publication is not permitted' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM founder_hub.workspaces WHERE id = p_workspace_id
             AND e2ee_cloud_authority_after IS NOT NULL) THEN
    RAISE EXCEPTION 'This workspace requires a cloud-authoritative sync client' USING ERRCODE = 'A0002';
  END IF;

  IF jsonb_typeof(v_events) <> 'array' OR jsonb_array_length(v_events) > 64 THEN
    RAISE EXCEPTION 'E2EE freshness event batch is invalid' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_events) AS event(value)
    WHERE jsonb_typeof(event.value) <> 'object'
      OR COALESCE(event.value->>'record_id', '') !~ '^[A-Za-z0-9_-]{43}$'
      OR COALESCE(event.value->>'payload_hash', '') !~ '^[A-Za-z0-9_-]{43}$'
      OR octet_length(COALESCE(event.value->>'payload', '')) NOT BETWEEN 1 AND 16777216
      OR founder_hub_private.e2ee_freshness_payload_key_id(event.value->>'payload') IS NULL
      OR (
        v_workspace_kind = 'shared'
        AND founder_hub_private.e2ee_freshness_payload_key_id(event.value->>'payload')
          IS DISTINCT FROM v_active_key_id
      )
      OR event.value->>'payload_hash' <> rtrim(
        translate(
          encode(extensions.digest(event.value->>'payload', 'sha256'), 'base64'),
          '+/',
          '-_'
        ),
        '='
      )
  ) THEN
    RAISE EXCEPTION 'E2EE freshness event is invalid' USING ERRCODE = '22023';
  END IF;

  IF v_initialized_at IS NULL AND NOT p_initialize THEN
    RAISE EXCEPTION 'E2EE freshness witness is not initialized' USING ERRCODE = '55000';
  END IF;

  IF v_initialized_at IS NULL AND jsonb_array_length(v_events) = 0 THEN
    RAISE EXCEPTION 'E2EE freshness initialization requires established state'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO founder_hub.e2ee_freshness_events (
    workspace_id,
    record_id,
    payload_hash,
    payload,
    created_by
  )
  SELECT
    p_workspace_id,
    event.value->>'record_id',
    event.value->>'payload_hash',
    event.value->>'payload',
    p_actor_user_id
  FROM jsonb_array_elements(v_events) AS event(value)
  ON CONFLICT DO NOTHING;

  IF v_initialized_at IS NULL THEN
    UPDATE founder_hub.workspaces AS workspace
    SET e2ee_freshness_initialized_at = now(),
        updated_at = now()
    WHERE workspace.id = p_workspace_id
    RETURNING workspace.e2ee_freshness_initialized_at
    INTO v_initialized_at;
  END IF;

  RETURN QUERY
  SELECT
    v_initialized_at,
    COALESCE(MAX(event.sequence), 0)::bigint
  FROM founder_hub.e2ee_freshness_events AS event
  WHERE event.workspace_id = p_workspace_id;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub.accept_e2ee_replica_batch(
  p_actor_user_id uuid, p_workspace_id uuid, p_mutation_id uuid,
  p_base_sequence bigint, p_initialize boolean, p_events jsonb
) RETURNS TABLE (initialized_at timestamptz, head_sequence bigint,
                 cloud_authority_after bigint, mutation_id uuid, receipts jsonb)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_workspace founder_hub.workspaces%ROWTYPE;
  v_key text;
  v_head bigint;
  v_hash text;
  v_receipt founder_hub.e2ee_replica_receipts%ROWTYPE;
  v_receipts jsonb;
BEGIN
  IF p_mutation_id IS NULL OR p_base_sequence IS NULL OR p_base_sequence < 0
     OR p_initialize IS NULL OR p_events IS NULL OR jsonb_typeof(p_events) <> 'array'
     OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 1024 THEN
    RAISE EXCEPTION 'Invalid replica batch' USING ERRCODE = '22023';
  END IF;
  v_key := founder_hub_private.active_e2ee_freshness_key_id(p_actor_user_id, p_workspace_id);
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Replica access denied' USING ERRCODE = '42501';
  END IF;
  -- Receipt replays must survive an advanced head. Reject only new stale mutations here.
  IF NOT EXISTS (SELECT 1 FROM founder_hub.e2ee_replica_receipts
                 WHERE workspace_id = p_workspace_id AND e2ee_replica_receipts.mutation_id = p_mutation_id)
     AND (SELECT COALESCE(max(sequence), 0) FROM founder_hub.e2ee_freshness_events
          WHERE workspace_id = p_workspace_id) <> p_base_sequence THEN
    RAISE EXCEPTION 'Replica base changed; pull before retrying' USING ERRCODE = '40001';
  END IF;
  PERFORM founder_hub_private.admit_e2ee_witness_write();
  SELECT * INTO v_workspace FROM founder_hub.workspaces WHERE id = p_workspace_id FOR UPDATE NOWAIT;
  v_key := founder_hub_private.active_e2ee_freshness_key_id(p_actor_user_id, p_workspace_id);
  IF v_workspace.id IS NULL OR v_key IS NULL THEN
    RAISE EXCEPTION 'Replica access denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_receipt FROM founder_hub.e2ee_replica_receipts
    WHERE workspace_id = p_workspace_id AND e2ee_replica_receipts.mutation_id = p_mutation_id;
  IF FOUND THEN
    v_hash := encode(extensions.digest(jsonb_build_array(p_base_sequence, p_initialize, p_events)::text, 'sha256'), 'hex');
    IF v_receipt.request_hash <> v_hash THEN
      RAISE EXCEPTION 'Mutation identity was reused' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_workspace.e2ee_freshness_initialized_at, v_receipt.accepted_head,
      v_workspace.e2ee_cloud_authority_after, p_mutation_id, v_receipt.events;
    RETURN;
  END IF;
  SELECT COALESCE(max(sequence), 0) INTO v_head FROM founder_hub.e2ee_freshness_events WHERE workspace_id = p_workspace_id;
  IF v_head <> p_base_sequence THEN
    RAISE EXCEPTION 'Replica base changed; pull before retrying' USING ERRCODE = '40001';
  END IF;
  v_hash := encode(extensions.digest(jsonb_build_array(p_base_sequence, p_initialize, p_events)::text, 'sha256'), 'hex');
  IF v_workspace.e2ee_freshness_initialized_at IS NULL AND NOT p_initialize THEN
    RAISE EXCEPTION 'Replica requires established state' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_events) AS event(value)
    WHERE jsonb_typeof(event.value) <> 'object'
      OR COALESCE(event.value->>'record_id', '') !~ '^[A-Za-z0-9_-]{43}$'
      OR COALESCE(event.value->>'payload_hash', '') !~ '^[A-Za-z0-9_-]{43}$'
      OR octet_length(COALESCE(event.value->>'payload', '')) NOT BETWEEN 1 AND 16777216
      OR founder_hub_private.e2ee_freshness_payload_key_id(event.value->>'payload') IS NULL
      OR (v_workspace.kind::text = 'shared' AND founder_hub_private.e2ee_freshness_payload_key_id(event.value->>'payload') IS DISTINCT FROM v_key)
      OR event.value->>'payload_hash' <> rtrim(translate(encode(extensions.digest(event.value->>'payload', 'sha256'), 'base64'), '+/', '-_'), '=')
  ) OR (SELECT count(DISTINCT value->>'record_id') FROM jsonb_array_elements(p_events)) <> jsonb_array_length(p_events) THEN
    RAISE EXCEPTION 'Invalid replica event' USING ERRCODE = '22023';
  END IF;
  UPDATE founder_hub.workspaces SET
    e2ee_cloud_authority_after = COALESCE(e2ee_cloud_authority_after, v_head),
    e2ee_freshness_initialized_at = COALESCE(e2ee_freshness_initialized_at, now())
    WHERE id = p_workspace_id RETURNING * INTO v_workspace;
  WITH accepted AS (
    INSERT INTO founder_hub.e2ee_freshness_events(workspace_id, record_id, payload_hash, payload, created_by, protocol)
    SELECT p_workspace_id, value->>'record_id', value->>'payload_hash', value->>'payload', p_actor_user_id, 2
    FROM jsonb_array_elements(p_events)
    RETURNING sequence, record_id, payload_hash
  ) SELECT max(sequence), jsonb_agg(jsonb_build_object('sequence', sequence, 'recordId', record_id, 'payloadHash', payload_hash) ORDER BY sequence)
    INTO v_head, v_receipts FROM accepted;
  INSERT INTO founder_hub.e2ee_replica_receipts VALUES (p_workspace_id, p_mutation_id, v_hash, v_head, v_receipts);
  RETURN QUERY SELECT v_workspace.e2ee_freshness_initialized_at, v_head,
    v_workspace.e2ee_cloud_authority_after, p_mutation_id, v_receipts;
END;
$$;
REVOKE ALL ON FUNCTION founder_hub.accept_e2ee_replica_batch(uuid, uuid, uuid, bigint, boolean, jsonb) FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.accept_e2ee_replica_batch(uuid, uuid, uuid, bigint, boolean, jsonb) TO cloud_service;

