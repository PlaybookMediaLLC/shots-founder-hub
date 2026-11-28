import { createServerFn } from "@tanstack/react-start";

import { getCloudServerClient } from "@/functions/cloud-client";
import { retryPendingReferral } from "@/functions/referrals";
import { captureOperationalError } from "@/lib/error-reporting";
import { clearServerAnalyticsIdentity } from "@/lib/server-analytics";

export const fetchUser = createServerFn({ method: "GET" }).handler(async () => {
  const cloudClient = getCloudServerClient();
  const { data, error: _error } = await cloudClient.auth.getUser();

  if (!data.user?.email) {
    return null;
  }

  await retryPendingReferral(cloudClient, data.user.id).catch(
    (error: unknown) =>
      captureOperationalError(error, { operation: "referral_claim_retry" }),
  );

  return {
    id: data.user.id,
    email: data.user.email,
    shotsUserId:
      typeof data.user.app_metadata.shots_user_id === "string"
        ? data.user.app_metadata.shots_user_id
        : null,
  };
});

export const signOutFn = createServerFn({ method: "POST" }).handler(
  async () => {
    const cloudClient = getCloudServerClient();
    const { error } = await cloudClient.auth.signOut({ scope: "local" });

    if (error) {
      return { success: false, message: error.message };
    }

    clearServerAnalyticsIdentity();
    return { success: true };
  },
);

export const signOutEverywhereFn = createServerFn({ method: "POST" }).handler(
  async () => ({
    success: false,
    message: "Manage all your sessions in Shots account settings.",
  }),
);
