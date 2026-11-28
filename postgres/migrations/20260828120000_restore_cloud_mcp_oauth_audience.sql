-- The required-SSO migration replaced custom_access_token_hook and dropped the
-- OAuth audience wrapper. Restore the wrapper around the current hook body so
-- OAuth access tokens are bound only to the hosted MCP resource.
DO $$
DECLARE
  live_def text;
BEGIN
  live_def := pg_get_functiondef('founder_hub.custom_access_token_hook(jsonb)'::regprocedure);

  IF live_def LIKE '%custom_access_token_hook_base%'
    AND position('https://api.anarlog.so/mcp' in live_def) > 0 THEN
    RETURN;
  END IF;

  IF to_regprocedure('founder_hub.custom_access_token_hook_base(jsonb)') IS NOT NULL THEN
    DROP FUNCTION founder_hub.custom_access_token_hook_base(jsonb);
  END IF;

  ALTER FUNCTION founder_hub.custom_access_token_hook(jsonb)
    RENAME TO custom_access_token_hook_base;
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
      '["https://api.anarlog.so/mcp"]'::jsonb
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
