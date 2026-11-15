

SET LOCAL lock_timeout = '30s';

-- Sync access remains gated by Pro entitlement. Raising the included allowance
-- applies to existing accounts without changing devices or purchased add-ons.
CREATE OR REPLACE FUNCTION founder_hub_private.sync_device_limit(p_actor_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT 5 + founder_hub_private.sync_device_addon_count(p_actor_user_id);
$$;

REVOKE ALL ON FUNCTION founder_hub_private.sync_device_limit(uuid)
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.sync_device_limit(uuid) TO cloud_service;

