import { createClientOnlyFn, createServerOnlyFn } from "@tanstack/react-start";
import { getCookies, setCookie } from "@tanstack/react-start/server";

import { createClient, type CloudClient } from "@anlg/cloud-client";
import { cookieStorage } from "@anlg/cloud-client/cookies";
import { getShotsCloudUrl } from "@anlg/cloud-client/shots";

import { env } from "@/env";

let browserClient: CloudClient | undefined;
export const getCloudBrowserClient = createClientOnlyFn(() => {
  browserClient ??= createClient(getShotsCloudUrl(env.VITE_API_URL), {
    auth: {
      autoRefreshToken: true,
      storage: cookieStorage(
        () =>
          Object.fromEntries(
            document.cookie
              .split(";")
              .filter(Boolean)
              .map((item) => {
                const [name, ...value] = item.trim().split("=");
                try {
                  return [name!, decodeURIComponent(value.join("="))];
                } catch {
                  return [name!, ""];
                }
              }),
          ),
        (name, value, maxAge) => {
          document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAge}${location.protocol === "https:" ? "; Secure" : ""}`;
        },
      ),
    },
  });
  return browserClient;
});

export const getCloudServerClient = createServerOnlyFn(() =>
  createClient(getShotsCloudUrl(env.VITE_API_URL), {
    auth: {
      autoRefreshToken: false,
      storage: cookieStorage(getCookies, (name, value, maxAge) => {
        setCookie(name, value, {
          path: "/",
          sameSite: "lax",
          secure: new URL(env.VITE_APP_URL).protocol === "https:",
          maxAge,
          httpOnly: false,
        });
      }),
    },
  }),
);

export const getCloudPublicServerClient = createServerOnlyFn(() =>
  createClient(getShotsCloudUrl(env.VITE_API_URL), {
    auth: { persistSession: false },
  }),
);
