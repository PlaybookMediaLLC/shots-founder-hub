CREATE OR REPLACE FUNCTION private.cloud_api_user_has_pro(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM private.shots_accounts WHERE user_id = p_user_id)
  THEN EXISTS (
    SELECT 1 FROM private.shots_memberships AS membership
    JOIN private.shots_workspaces AS workspace ON workspace.workspace_id = membership.workspace_id
    WHERE membership.user_id = p_user_id
      AND 'workspace:read' = ANY(membership.permissions)
      AND workspace.features->'workspace:paid' = 'true'::jsonb
  ) ELSE (
    EXISTS (
      SELECT 1 FROM public.profiles AS profile
      JOIN stripe.active_entitlements AS entitlement ON entitlement.customer = profile.stripe_customer_id
      WHERE profile.id = p_user_id AND entitlement.lookup_key = 'hyprnote_pro'
    ) OR EXISTS (
      SELECT 1 FROM public.profiles AS profile
      JOIN stripe.subscriptions AS subscription ON subscription.customer = profile.stripe_customer_id
      WHERE profile.id = p_user_id AND subscription.status = 'trialing'
        AND (subscription.trial_end #>> '{}')::bigint > extract(epoch FROM now())::bigint
    ) OR EXISTS (
      SELECT 1 FROM public.workspace_memberships AS membership
      JOIN public.workspaces AS workspace ON workspace.id = membership.workspace_id
      JOIN stripe.active_entitlements AS entitlement ON entitlement.customer = workspace.stripe_customer_id
      WHERE membership.user_id = p_user_id AND membership.deleted_at IS NULL
        AND workspace.deleted_at IS NULL AND entitlement.lookup_key = 'hyprnote_pro'
    ) OR EXISTS (
      SELECT 1 FROM public.workspace_memberships AS membership
      JOIN public.workspaces AS workspace ON workspace.id = membership.workspace_id
      JOIN stripe.subscriptions AS subscription ON subscription.customer = workspace.stripe_customer_id
      WHERE membership.user_id = p_user_id AND membership.deleted_at IS NULL
        AND workspace.deleted_at IS NULL AND subscription.status = 'trialing'
        AND (subscription.trial_end #>> '{}')::bigint > extract(epoch FROM now())::bigint
    )
  ) END;
$$;

CREATE TABLE private.shots_api_key_bindings (
  key_id uuid PRIMARY KEY REFERENCES public.api_keys(id) ON DELETE CASCADE,
  shots_user_id text NOT NULL CHECK (length(shots_user_id) BETWEEN 1 AND 160),
  shots_session_id text NOT NULL CHECK (length(shots_session_id) BETWEEN 1 AND 160)
);
REVOKE ALL ON private.shots_api_key_bindings FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.create_shots_cloud_api_key(
  p_actor_user_id uuid, p_id uuid, p_name text, p_key_hash text, p_key_prefix text,
  p_shots_user_id text, p_shots_session_id text
)
RETURNS TABLE (id uuid, name text, key_prefix text, created_at timestamptz, last_used_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.shots_accounts
    WHERE user_id = p_actor_user_id AND shots_user_id = p_shots_user_id) THEN
    RAISE EXCEPTION 'Shots identity mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.create_cloud_api_key(p_actor_user_id, p_id, p_name, p_key_hash, p_key_prefix);
  INSERT INTO private.shots_api_key_bindings (key_id, shots_user_id, shots_session_id)
    VALUES (p_id, p_shots_user_id, p_shots_session_id);
END;
$$;

-- This lookup proves only key possession. The API must resolve live Shots authority before reading data.
CREATE FUNCTION public.lookup_shots_cloud_api_key(p_key_hash text)
RETURNS TABLE (user_id uuid, shots_user_id text, shots_session_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT key.user_id, binding.shots_user_id, binding.shots_session_id
  FROM public.api_keys AS key
  JOIN private.shots_api_key_bindings AS binding ON binding.key_id = key.id
  JOIN private.shots_accounts AS account ON account.user_id = key.user_id AND account.shots_user_id = binding.shots_user_id
  WHERE key.key_hash = p_key_hash AND key.revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.create_shots_cloud_api_key(uuid, uuid, text, text, text, text, text),
  public.lookup_shots_cloud_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_shots_cloud_api_key(uuid, uuid, text, text, text, text, text),
  public.lookup_shots_cloud_api_key(text) TO service_role;

ALTER FUNCTION public.verify_cloud_api_key(text) SET SCHEMA private;
CREATE FUNCTION public.verify_cloud_api_key(p_key_hash text)
RETURNS TABLE (user_id uuid, status text)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT verified.* FROM private.verify_cloud_api_key(p_key_hash) AS verified
  WHERE NOT EXISTS (SELECT 1 FROM private.shots_accounts AS account WHERE account.user_id = verified.user_id);
$$;

CREATE FUNCTION public.verify_shots_cloud_api_key(p_key_hash text)
RETURNS TABLE (user_id uuid, status text)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT verified.* FROM private.verify_cloud_api_key(p_key_hash) AS verified
  JOIN public.lookup_shots_cloud_api_key(p_key_hash) AS binding ON binding.user_id = verified.user_id;
$$;
REVOKE ALL ON FUNCTION public.verify_cloud_api_key(text), public.verify_shots_cloud_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_cloud_api_key(text), public.verify_shots_cloud_api_key(text)
  TO service_role;
