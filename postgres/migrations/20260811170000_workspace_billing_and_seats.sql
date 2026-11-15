-- Team plans are billed to the workspace, not to whoever happens to own it, so
-- billing survives an ownership transfer and members inherit entitlement from
-- the workspace subscription instead of buying their own.



SET LOCAL lock_timeout = '30s';

-- Token refreshes read founder_hub_identity.users before the workspace tables. Lock in that
-- same order so concurrent refreshes cannot deadlock against this migration.
LOCK TABLE
  founder_hub_identity.users,
  founder_hub.workspaces,
  founder_hub.workspace_memberships,
  founder_hub.workspace_invitations
IN ACCESS EXCLUSIVE MODE;

ALTER TABLE founder_hub.workspaces
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN seat_limit integer,
  ADD CONSTRAINT workspaces_seat_limit_check CHECK (
    seat_limit IS NULL OR seat_limit > 0
  ),
  ADD CONSTRAINT workspaces_billing_is_shared_check CHECK (
    stripe_customer_id IS NULL OR kind = 'shared'
  );

CREATE UNIQUE INDEX workspaces_stripe_customer_key
  ON founder_hub.workspaces(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Seats are consumed by people who hold access and by invitations that can
-- still be accepted, so an admin cannot oversubscribe by queueing invites.
CREATE OR REPLACE FUNCTION founder_hub_private.workspace_seat_usage(
  p_workspace_id uuid
)
RETURNS TABLE (
  seat_limit integer,
  used_seats integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    workspace.seat_limit,
    (
      (
        SELECT count(*)
        FROM founder_hub.workspace_memberships AS membership
        WHERE membership.workspace_id = workspace.id
          AND membership.deleted_at IS NULL
      )
      + (
        SELECT count(*)
        FROM founder_hub.workspace_invitations AS invitation
        WHERE invitation.workspace_id = workspace.id
          AND invitation.accepted_at IS NULL
          AND invitation.revoked_at IS NULL
          AND invitation.expires_at > now()
          -- Mid-acceptance the membership lands before the invitation is
          -- stamped accepted; without this the same person holds two seats.
          AND NOT EXISTS (
            SELECT 1
            FROM founder_hub.workspace_memberships AS seated
            WHERE seated.workspace_id = invitation.workspace_id
              AND seated.user_id = invitation.invitee_user_id
              AND seated.deleted_at IS NULL
          )
      )
    )::integer
  FROM founder_hub.workspaces AS workspace
  WHERE workspace.id = p_workspace_id;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.workspace_seat_usage(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;

CREATE OR REPLACE FUNCTION founder_hub_private.enforce_workspace_seat_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid := NEW.workspace_id;
  v_usage record;
BEGIN
  -- Nested rather than one condition: plpgsql resolves OLD/NEW field references
  -- even in branches that cannot run, and invitations have no deleted_at.
  IF TG_TABLE_NAME = 'workspace_memberships' THEN
    IF TG_OP = 'UPDATE' THEN
      -- Reactivating a soft-deleted row takes a seat again; nothing else does.
      IF NOT (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) THEN
        RETURN NEW;
      END IF;
    ELSIF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT * INTO v_usage FROM founder_hub_private.workspace_seat_usage(v_workspace_id);

  IF v_usage.seat_limit IS NOT NULL AND v_usage.used_seats > v_usage.seat_limit THEN
    RAISE EXCEPTION 'workspace seat limit reached'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.enforce_workspace_seat_limit()
  FROM PUBLIC, cloud_anonymous, cloud_member;

CREATE CONSTRAINT TRIGGER on_workspace_membership_seat_limit
  AFTER INSERT OR UPDATE OF deleted_at ON founder_hub.workspace_memberships
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION founder_hub_private.enforce_workspace_seat_limit();

CREATE CONSTRAINT TRIGGER on_workspace_invitation_seat_limit
  AFTER INSERT ON founder_hub.workspace_invitations
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION founder_hub_private.enforce_workspace_seat_limit();

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
    workspace.stripe_customer_id IS NOT NULL
  FROM founder_hub.workspaces AS workspace
  CROSS JOIN LATERAL founder_hub_private.workspace_seat_usage(workspace.id) AS usage
  WHERE workspace.id = p_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.get_workspace_seat_usage(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.get_workspace_seat_usage(uuid)
  TO cloud_member;

CREATE OR REPLACE FUNCTION founder_hub.get_workspace_seat_usage(
  p_workspace_id uuid
)
RETURNS TABLE (
  seat_limit integer,
  used_seats integer,
  is_billed boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT * FROM founder_hub_private.get_workspace_seat_usage(p_workspace_id);
$$;

REVOKE ALL ON FUNCTION founder_hub.get_workspace_seat_usage(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.get_workspace_seat_usage(uuid)
  TO cloud_member;

-- The auth hook now unions two sources of entitlement: what the account bought
-- for itself, and what any workspace it belongs to bought on its behalf. Which
-- features a Team plan carries stays a Stripe product decision, so no gate in
-- the app has to learn about team plans.
GRANT SELECT ON TABLE founder_hub.workspaces TO cloud_identity_admin;
GRANT SELECT ON TABLE founder_hub.workspace_memberships TO cloud_identity_admin;

CREATE POLICY "Allow auth admin to read workspaces"
ON founder_hub.workspaces
AS PERMISSIVE FOR SELECT
TO cloud_identity_admin
USING (true);

CREATE POLICY "Allow auth admin to read workspace memberships"
ON founder_hub.workspace_memberships
AS PERMISSIVE FOR SELECT
TO cloud_identity_admin
USING (true);

-- search_path is pinned here rather than left to the ALTER in
-- 20260714134923: CREATE OR REPLACE resets attributes it does not restate.
CREATE OR REPLACE FUNCTION founder_hub.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  claims jsonb;
  entitlements jsonb := '[]'::jsonb;
  v_user_id uuid := (event->>'user_id')::uuid;
  v_customer_id text;
  v_subscription_status text;
  v_trial_end bigint;
  v_has_payment_method boolean;
BEGIN
  SELECT p.stripe_customer_id INTO v_customer_id
  FROM founder_hub.profiles p
  WHERE p.id = v_user_id;

  SELECT
    COALESCE(
      jsonb_agg(DISTINCT granted.lookup_key ORDER BY granted.lookup_key)
        FILTER (WHERE granted.lookup_key IS NOT NULL),
      '[]'::jsonb
    )
  INTO entitlements
  FROM (
    SELECT ae.lookup_key
    FROM founder_hub.profiles p
    JOIN stripe.active_entitlements ae
      ON ae.customer = p.stripe_customer_id
    WHERE p.id = v_user_id

    UNION

    SELECT ae.lookup_key
    FROM founder_hub.workspace_memberships m
    JOIN founder_hub.workspaces w
      ON w.id = m.workspace_id
    JOIN stripe.active_entitlements ae
      ON ae.customer = w.stripe_customer_id
    WHERE m.user_id = v_user_id
      AND m.deleted_at IS NULL
      AND w.deleted_at IS NULL
      AND w.stripe_customer_id IS NOT NULL
  ) AS granted;

  IF v_customer_id IS NOT NULL THEN
    SELECT
      s.status::text,
      (s.trial_end #>> '{}')::bigint,
      s.default_payment_method IS NOT NULL
        OR c.invoice_settings->>'default_payment_method' IS NOT NULL
        OR c.default_source IS NOT NULL
    INTO v_subscription_status, v_trial_end, v_has_payment_method
    FROM stripe.subscriptions s
    JOIN stripe.customers c ON c.id = s.customer
    WHERE s.customer = v_customer_id
      AND s.status IN ('trialing', 'active')
    ORDER BY
      CASE s.status WHEN 'active' THEN 1 WHEN 'trialing' THEN 2 END,
      s.created DESC
    LIMIT 1;
  END IF;

  -- A member with no subscription of their own still reads as subscribed while
  -- a workspace covers them; personal billing state wins when both exist.
  IF v_subscription_status IS NULL THEN
    SELECT s.status::text
    INTO v_subscription_status
    FROM founder_hub.workspace_memberships m
    JOIN founder_hub.workspaces w
      ON w.id = m.workspace_id
    JOIN stripe.subscriptions s
      ON s.customer = w.stripe_customer_id
    WHERE m.user_id = v_user_id
      AND m.deleted_at IS NULL
      AND w.deleted_at IS NULL
      AND w.stripe_customer_id IS NOT NULL
      AND s.status IN ('trialing', 'active')
    ORDER BY
      CASE s.status WHEN 'active' THEN 1 WHEN 'trialing' THEN 2 END,
      s.created DESC
    LIMIT 1;
  END IF;

  claims := event->'claims';
  claims := jsonb_set(claims, '{entitlements}', entitlements);

  IF v_subscription_status IS NOT NULL THEN
    claims := jsonb_set(claims, '{subscription_status}', to_jsonb(v_subscription_status));
  END IF;

  IF v_trial_end IS NOT NULL THEN
    claims := jsonb_set(claims, '{trial_end}', to_jsonb(v_trial_end));
  END IF;

  IF v_has_payment_method IS NOT NULL THEN
    claims := jsonb_set(claims, '{has_payment_method}', to_jsonb(v_has_payment_method));
  END IF;

  event := jsonb_set(event, '{claims}', claims);

  RETURN event;
END;
$$;

