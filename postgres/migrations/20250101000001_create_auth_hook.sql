CREATE OR REPLACE FUNCTION founder_hub.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  claims jsonb;
  entitlements jsonb := '[]'::jsonb;
BEGIN
  SELECT
    COALESCE(
      jsonb_agg(ae.lookup_key ORDER BY ae.lookup_key)
        FILTER (WHERE ae.lookup_key IS NOT NULL),
      '[]'::jsonb
    )
  INTO entitlements
  FROM founder_hub.profiles p
  JOIN stripe.active_entitlements ae
    ON ae.customer = p.stripe_customer_id
  WHERE p.id = (event->>'user_id')::uuid;

  claims := event->'claims';
  claims := jsonb_set(claims, '{entitlements}', entitlements);
  event := jsonb_set(event, '{claims}', claims);

  RETURN event;
END;
$$;

GRANT USAGE ON SCHEMA founder_hub TO cloud_identity_admin;

GRANT EXECUTE ON FUNCTION founder_hub.custom_access_token_hook TO cloud_identity_admin;

REVOKE EXECUTE ON FUNCTION founder_hub.custom_access_token_hook FROM cloud_member, cloud_anonymous, public;

GRANT SELECT ON TABLE founder_hub.profiles TO cloud_identity_admin;

CREATE POLICY "Allow auth admin to read profiles"
ON founder_hub.profiles
AS PERMISSIVE FOR SELECT
TO cloud_identity_admin
USING (true);

GRANT USAGE ON SCHEMA stripe TO cloud_identity_admin;
GRANT SELECT ON TABLE stripe.active_entitlements TO cloud_identity_admin;
