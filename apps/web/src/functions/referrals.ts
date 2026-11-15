import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import {
  deleteCookie,
  getCookie,
  getRequestHeaders,
  setCookie,
  setResponseHeader,
} from "@tanstack/react-start/server";
import { z } from "zod";

import type { CloudClient } from "@anlg/cloud-client";

import { getRequestAppOrigin } from "@/functions/app-origin";
import {
  getCloudPublicServerClient,
  getCloudServerClient,
} from "@/functions/cloud-client";
import { claimReferralCode } from "@/lib/referral-claim";
import { captureServerAnalytics } from "@/lib/server-analytics";

const REFERRAL_COOKIE = "anarlog-referral";
const REFERRAL_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const referralCodeSchema = z.string().regex(/^[a-f0-9]{24}$/);

import type { ReferralSummary } from "@anlg/cloud-client/referrals";
import { proTrialDaysForOffer } from "@anlg/pricing/trial";

export const persistReferralAttribution = createServerFn({ method: "POST" })
  .validator(referralCodeSchema)
  .handler(async ({ data: code }) => {
    setPrivateResponseHeaders();
    const cloudClient = getCloudServerClient();
    const {
      data: { user },
    } = await cloudClient.auth.getUser();

    const trackVisit = (entry_point: string) =>
      getRequestHeaders().get("sec-gpc") === "1"
        ? Promise.resolve()
        : captureServerAnalytics({
            userId: "",
            event: "referral_link_visited",
            timestamp: new Date(),
            properties: { entry_point },
          }).catch(() => {});

    if (user) {
      await trackVisit("existing_account");
      deleteCookie(REFERRAL_COOKIE, { path: "/" });
      return "existing_account" as const;
    }

    const { data: available, error } = await cloudClient.rpc(
      "referral_link_available",
      { p_code: code },
    );
    if (error) throw error;
    if (available !== true) {
      await trackVisit("unavailable");
      deleteCookie(REFERRAL_COOKIE, { path: "/" });
      return "unavailable" as const;
    }
    setCookie(REFERRAL_COOKIE, code, {
      httpOnly: true,
      maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "lax",
      secure: getRequestAppOrigin().startsWith("https://"),
    });
    await trackVisit("available");
    return "stored" as const;
  });

export const claimPendingReferral = createServerOnlyFn(
  async (accessToken: string, userId: string) => {
    const rawCode = getCookie(REFERRAL_COOKIE);
    const parsedCode = referralCodeSchema.safeParse(rawCode);
    if (!parsedCode.success) {
      if (rawCode) {
        deleteCookie(REFERRAL_COOKIE, { path: "/" });
      }
      return false;
    }

    const claimed = await claimReferralCode(
      getCloudPublicServerClient(),
      accessToken,
      parsedCode.data,
    );
    deleteCookie(REFERRAL_COOKIE, { path: "/" });
    if (claimed && getRequestHeaders().get("sec-gpc") !== "1") {
      await captureServerAnalytics({
        userId,
        event: "referral_claimed",
        insertId: `referral-claim:${userId}`,
        timestamp: new Date(),
        properties: { entry_point: "invite" },
      }).catch(() => {});
    }
    return claimed;
  },
);

export const getProTrialDays = createServerOnlyFn(
  async (cloudClient: CloudClient) => {
    const { data, error } = await cloudClient.rpc("get_pro_trial_offer");
    if (error) {
      throw error;
    }
    return proTrialDaysForOffer(
      data === "referral" || data === "work_email" ? data : "personal_email",
    );
  },
);

export const getReferralInvites = createServerFn({ method: "POST" }).handler(
  async () => {
    setPrivateResponseHeaders();
    const cloudClient = getCloudServerClient();
    const {
      data: { user },
    } = await cloudClient.auth.getUser();
    if (!user?.id || user.is_anonymous) {
      throw new Error("Unauthorized");
    }

    const { data, error } = await cloudClient.rpc("get_referral_summary");
    if (error) {
      throw error;
    }

    return data as ReferralSummary;
  },
);

function setPrivateResponseHeaders() {
  setResponseHeader("Cache-Control", "private, no-store");
  setResponseHeader("Referrer-Policy", "no-referrer");
  setResponseHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
}
