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
} from "@anlg/supabase/shots";

import { env, requireEnv } from "@/env";
import { getSupabaseServerClient } from "@/functions/supabase";
import { sanitizeInternalReturnPath } from "@/lib/auth-redirect";

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
      const { error } = await getSupabaseServerClient().auth.setSession(tokens);
      if (error) throw error;
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
