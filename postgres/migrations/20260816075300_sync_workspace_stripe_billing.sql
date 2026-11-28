

CREATE OR REPLACE FUNCTION founder_hub.sync_workspace_stripe_billing(
  p_workspace_id uuid,
  p_stripe_customer_id text,
  p_seat_limit integer DEFAULT NULL,
  p_update_seat_limit boolean DEFAULT false
)
RETURNS TABLE (
  assigned_customer_id text,
  seat_limit integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace founder_hub.workspaces%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL
    OR p_stripe_customer_id IS NULL
    OR length(p_stripe_customer_id) > 255
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
    OR p_update_seat_limit IS NULL
    OR (p_update_seat_limit AND p_seat_limit IS NOT NULL AND p_seat_limit <= 0)
    OR (NOT p_update_seat_limit AND p_seat_limit IS NOT NULL)
  THEN
    RAISE EXCEPTION 'invalid workspace Stripe billing update'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text, 75300)
  );

  SELECT workspace.*
  INTO v_workspace
  FROM founder_hub.workspaces AS workspace
  WHERE workspace.id = p_workspace_id
    AND workspace.kind = 'shared'
    AND workspace.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    assigned_customer_id := NULL;
    seat_limit := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_workspace.stripe_customer_id IS NULL
    OR v_workspace.stripe_customer_id = p_stripe_customer_id
  THEN
    UPDATE founder_hub.workspaces AS workspace
    SET
      stripe_customer_id = p_stripe_customer_id,
      seat_limit = CASE
        WHEN p_update_seat_limit THEN p_seat_limit
        ELSE workspace.seat_limit
      END,
      updated_at = clock_timestamp()
    WHERE workspace.id = p_workspace_id
    RETURNING workspace.stripe_customer_id, workspace.seat_limit
    INTO assigned_customer_id, seat_limit;

    RETURN NEXT;
    RETURN;
  END IF;

  assigned_customer_id := v_workspace.stripe_customer_id;
  seat_limit := v_workspace.seat_limit;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub.sync_workspace_stripe_billing(
  uuid,
  text,
  integer,
  boolean
) FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.sync_workspace_stripe_billing(
  uuid,
  text,
  integer,
  boolean
) TO cloud_service;

CREATE OR REPLACE FUNCTION founder_hub_private.get_workspace_seat_usage(
  p_workspace_id uuid
)
RETURNS TABLE (
  seat_limit integer,
  used_seats integer,
  is_billed boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM founder_hub.workspaces AS workspace
    JOIN founder_hub.workspace_memberships AS membership
      ON membership.workspace_id = workspace.id
    WHERE workspace.id = p_workspace_id
      AND workspace.deleted_at IS NULL
      AND membership.user_id = founder_hub_identity.user_id()
      AND membership.role IN ('owner', 'admin')
      AND membership.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'workspace billing operation not permitted'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    usage.seat_limit,
    usage.used_seats,
    EXISTS (
      SELECT 1
      FROM stripe.subscriptions AS subscription
      WHERE subscription.customer = workspace.stripe_customer_id
        AND subscription.status IN ('trialing', 'active')
    )
  FROM founder_hub.workspaces AS workspace
  CROSS JOIN LATERAL founder_hub_private.workspace_seat_usage(workspace.id) AS usage
  WHERE workspace.id = p_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.get_workspace_seat_usage(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.get_workspace_seat_usage(uuid)
  TO cloud_member;

