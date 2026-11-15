import type { CloudClient } from "@anlg/cloud-client";

// Sign-in sets the session cookie in the same request, and the client cannot
// read it yet, so the new access token is sent directly. A slow claim must not
// hold the sign-in redirect.
export async function claimReferralCode(
  client: CloudClient,
  accessToken: string,
  code: string,
) {
  const { data, error } = await client
    .rpc("claim_referral", { p_code: code })
    .setHeader("Authorization", `Bearer ${accessToken}`)
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw error;
  return data === true;
}
