-- Repair environments where the OAuth audience wrapper was recorded but the
-- underlying function replacement did not persist.
DO $$
BEGIN
  IF to_regprocedure('founder_hub.custom_access_token_hook_base(jsonb)') IS NULL THEN
    ALTER FUNCTION founder_hub.custom_access_token_hook(jsonb)
      RENAME TO custom_access_token_hook_base;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  claims jsonb;
BEGIN
  event := founder_hub.custom_access_token_hook_base(event);
  claims := event->'claims';

  IF NULLIF(claims->>'client_id', '') IS NOT NULL THEN
    claims := jsonb_set(
      claims,
      '{aud}',
      '["cloud_member", "https://api.anarlog.so/mcp"]'::jsonb
    );
    event := jsonb_set(event, '{claims}', claims);
  END IF;

  RETURN event;
END;
$$;

GRANT EXECUTE ON FUNCTION founder_hub.custom_access_token_hook(jsonb)
  TO cloud_identity_admin;
REVOKE EXECUTE ON FUNCTION founder_hub.custom_access_token_hook(jsonb)
  FROM cloud_member, cloud_anonymous, public;
