-- New-user trials can earn more trial time; paid extensions keep their paid founder_hub_identity.
CREATE OR REPLACE FUNCTION founder_hub_private.can_refer_for_month(p_user_id uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM founder_hub.profiles p
    JOIN stripe.subscriptions s ON s.customer = p.stripe_customer_id
    WHERE p.id = p_user_id
      AND EXISTS (
        SELECT 1 FROM stripe.subscription_items si
        WHERE si.subscription = s.id
          AND si.price = ANY((SELECT price_ids FROM founder_hub_private.referral_program)::text[])
      )
      AND (
        s.status = 'active'
        OR (s.status = 'trialing' AND CASE
          WHEN jsonb_typeof(s.trial_end) = 'number'
          THEN (s.trial_end #>> '{}')::numeric > extract(epoch FROM now())
          ELSE false
        END)
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM founder_hub_private.account_deletion_jobs WHERE owner_user_id = p_user_id
  );
$$;
REVOKE ALL ON FUNCTION founder_hub_private.can_refer_for_month(uuid) FROM PUBLIC, cloud_anonymous, cloud_member;
