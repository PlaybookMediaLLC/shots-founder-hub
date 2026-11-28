-- Trial length depends on how the account signed up: referral and work (custom-domain)
-- emails get the long trial, personal emails the short one. Day counts live in
-- packages/pricing/src/trial-policy.json; this only classifies the caller.
CREATE FUNCTION founder_hub.get_pro_trial_offer()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN founder_hub_identity.user_id() IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1
      FROM founder_hub_private.referral_invites AS referral
      WHERE referral.referred_user_id = founder_hub_identity.user_id()
    ) THEN 'referral'
    WHEN founder_hub_private.email_auto_join_domain(founder_hub_identity.user_id()) IS NOT NULL THEN 'work_email'
    ELSE 'personal_email'
  END;
$$;

REVOKE ALL ON FUNCTION founder_hub.get_pro_trial_offer() FROM PUBLIC, cloud_anonymous;
GRANT EXECUTE ON FUNCTION founder_hub.get_pro_trial_offer() TO cloud_member;
