-- Old clients see this message, so it must name Shots Founder Hub.
CREATE OR REPLACE FUNCTION public.get_or_create_referral_invites()
RETURNS TABLE(slot smallint, code text, status text, reward_amount_cents integer, reward_currency text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT activated_at FROM private.referral_program) IS NOT NULL THEN
    RAISE EXCEPTION 'Please update Shots Founder Hub to view the new referral offer';
  END IF;
  RETURN QUERY SELECT * FROM private.get_or_create_legacy_referral_invites();
END;
$$;
