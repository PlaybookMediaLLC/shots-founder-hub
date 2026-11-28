import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import {
  deleteCookie,
  getCookie,
  setCookie,
} from "@tanstack/react-start/server";
import { z } from "zod";

import {
  createShotsAuthorization,
  exchangeShotsCallback,
  getShotsCloudUrl,
} from "@anlg/cloud-client/shots";

import { env, requireEnv } from "@/env";
import { getCloudServerClient } from "@/functions/cloud-client";
import { claimPendingReferral } from "@/functions/referrals";
import { sanitizeInternalReturnPath } from "@/lib/auth-redirect";
import { captureOperationalError } from "@/lib/error-reporting";

const pendingSchema = z.object({
  state: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
  issuer: z.string(),
  createdAt: z.number(),
  returnTo: z.string(),
});
const pendingCookie = () =>
  new URL(env.VITE_APP_URL).protocol === "https:"
    ? "__Host-shots-hub-oauth"
    : "shots-hub-oauth";

export const beginShotsWebAuth = createServerFn({ method: "POST" })
  .validator(
    z.object({
      returnTo: z.string().max(2048).optional(),
      switchAccount: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const pending = await createShotsAuthorization({
      shotsUrl: requireEnv(env.VITE_SHOTS_URL, "VITE_SHOTS_URL"),
      redirectUri: new URL("/callback/shots/", env.VITE_APP_URL).toString(),
      switchAccount: data.switchAccount,
    });
    setCookie(
      pendingCookie(),
      JSON.stringify({
        ...pending,
        createdAt: Date.now(),
        returnTo: sanitizeInternalReturnPath(data.returnTo),
      }),
      {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: pendingCookie().startsWith("__Host-"),
        maxAge: 600,
      },
    );
    return pending.url;
  });

export const finishShotsWebAuth = createServerOnlyFn(
  async (request: Request) => {
    const headers = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    };
    try {
      if (!env.VITE_SHOTS_URL)
        return new Response("Not found", { status: 404, headers });
      const pending = pendingSchema.parse(
        JSON.parse(getCookie(pendingCookie()) ?? "null"),
      );
      if (
        Date.now() < pending.createdAt ||
        Date.now() - pending.createdAt > 600_000 ||
        new URL(request.url).searchParams.get("state") !== pending.state ||
        pending.redirectUri !==
          new URL("/callback/shots/", env.VITE_APP_URL).toString() ||
        pending.issuer !== new URL("/api/auth", env.VITE_SHOTS_URL).toString()
      ) {
        throw new Error("Invalid sign-in callback");
      }
      deleteCookie(pendingCookie(), { path: "/" });
      const tokens = await exchangeShotsCallback({
        callback: request.url,
        pending,
        gatewayUrl: getShotsCloudUrl(env.VITE_API_URL),
      });
      const { data, error } =
        await getCloudServerClient().auth.setSession(tokens);
      if (error) throw error;
      if (data.user) {
        // A failed referral claim must not block sign-in.
        await claimPendingReferral(tokens.access_token, data.user.id).catch(
          (claimError: unknown) =>
            captureOperationalError(claimError, {
              operation: "referral_claim",
            }),
        );
      }
      return new Response(null, {
        status: 303,
        headers: {
          ...headers,
          Location: sanitizeInternalReturnPath(pending.returnTo),
        },
      });
    } catch {
      return new Response(
        "Sign-in failed. Return to /auth to start sign-in again.",
        { status: 400, headers },
      );
    }
  },
);
