-- Keep historical and already-prepared rewards at their original amount so
-- Stripe retries reuse the same parameters with the existing idempotency key.
ALTER TABLE founder_hub_private.referral_invites
  ADD COLUMN reward_amount_cents integer NOT NULL DEFAULT 1500
    CHECK (reward_amount_cents > 0);

ALTER TABLE founder_hub_private.referral_invites
  ALTER COLUMN reward_amount_cents SET DEFAULT 1400;

UPDATE founder_hub_private.referral_invites
SET reward_amount_cents = 1400
WHERE referred_user_id IS NULL AND qualifying_invoice_id IS NULL AND rewarded_at IS NULL;

CREATE OR REPLACE FUNCTION founder_hub.get_or_create_referral_invites()
RETURNS TABLE (
  slot smallint,
  code text,
  status text,
  reward_amount_cents integer,
  reward_currency text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := founder_hub_identity.user_id();
BEGIN
  IF v_user_id IS NULL
    OR NOT founder_hub_private.is_paid_referrer(v_user_id)
    OR EXISTS (
      SELECT 1
      FROM founder_hub_private.account_deletion_jobs AS deletion
      WHERE deletion.owner_user_id = v_user_id
    )
  THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 180001)
  );

  INSERT INTO founder_hub_private.referral_invites (
    referrer_user_id,
    slot,
    code
  )
  SELECT
    v_user_id,
    generated_slot,
    encode(extensions.gen_random_bytes(12), 'hex')
  FROM generate_series(1, 3) AS generated_slot
  ON CONFLICT ON CONSTRAINT referral_invites_referrer_slot_key DO NOTHING;

  RETURN QUERY
  SELECT
    referral.slot,
    referral.code,
    CASE
      WHEN referral.rewarded_at IS NOT NULL THEN 'reward_earned'
      WHEN referral.referred_user_id IS NOT NULL THEN 'trial_started'
      ELSE 'available'
    END,
    referral.reward_amount_cents,
    'usd'
  FROM founder_hub_private.referral_invites AS referral
  WHERE referral.referrer_user_id = v_user_id
  ORDER BY referral.slot;
END;
$$;

COMMENT ON FUNCTION founder_hub.get_or_create_referral_invites()
  IS 'Returns three referral slots for active paid Pro subscribers, including workspace seats, creating missing slots atomically.';

CREATE OR REPLACE FUNCTION founder_hub.prepare_referral_reward(
  p_referred_user_id uuid,
  p_invoice_id text
)
RETURNS TABLE (
  referral_id uuid,
  referrer_user_id uuid,
  referrer_customer_id text,
  reward_amount_cents integer,
  reward_currency text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_referral founder_hub_private.referral_invites%ROWTYPE;
  v_referrer_customer_id text;
BEGIN
  IF p_referred_user_id IS NULL
    OR p_invoice_id IS NULL
    OR p_invoice_id !~ '^in_[A-Za-z0-9]+$'
  THEN
    RETURN;
  END IF;

  SELECT referral.*
  INTO v_referral
  FROM founder_hub_private.referral_invites AS referral
  WHERE referral.referred_user_id = p_referred_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_referral.rewarded_at IS NOT NULL THEN
    RETURN;
  END IF;

  IF v_referral.qualifying_invoice_id IS NULL THEN
    UPDATE founder_hub_private.referral_invites
    SET
      qualifying_invoice_id = p_invoice_id,
      qualified_at = clock_timestamp()
    WHERE id = v_referral.id;
    v_referral.qualifying_invoice_id := p_invoice_id;
  ELSIF v_referral.qualifying_invoice_id <> p_invoice_id THEN
    RETURN;
  END IF;

  SELECT profile.stripe_customer_id
  INTO v_referrer_customer_id
  FROM founder_hub.profiles AS profile
  WHERE profile.id = v_referral.referrer_user_id;

  IF v_referrer_customer_id IS NULL THEN
    SELECT workspace.stripe_customer_id
    INTO v_referrer_customer_id
    FROM founder_hub.workspace_memberships AS membership
    JOIN founder_hub.workspaces AS workspace
      ON workspace.id = membership.workspace_id
    JOIN stripe.subscriptions AS subscription
      ON subscription.customer = workspace.stripe_customer_id
    WHERE membership.user_id = v_referral.referrer_user_id
      AND membership.deleted_at IS NULL
      AND workspace.kind = 'shared'
      AND workspace.deleted_at IS NULL
      AND workspace.stripe_customer_id IS NOT NULL
      AND subscription.status = 'active'
    ORDER BY workspace.created_at
    LIMIT 1;
  END IF;

  IF v_referrer_customer_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_referral.id,
    v_referral.referrer_user_id,
    v_referrer_customer_id,
    v_referral.reward_amount_cents,
    'usd';
END;
$$;

REVOKE ALL ON FUNCTION founder_hub.prepare_referral_reward(uuid, text)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.prepare_referral_reward(uuid, text)
  TO cloud_service;
