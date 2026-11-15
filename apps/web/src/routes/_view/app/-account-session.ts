import { useQuery } from "@tanstack/react-query";

import { deriveBillingInfo } from "@anlg/cloud-client";

import { getCloudBrowserClient } from "@/functions/cloud-client";

export const accountSessionQueryKey = ["account-session"];

export function useAccountSession() {
  return useQuery({
    queryKey: accountSessionQueryKey,
    // Skip the SSR fetch: the browser-only cloud client throws on the
    // server, and this data is session-scoped anyway.
    enabled: typeof window !== "undefined",
    queryFn: async () => {
      const cloudClient = getCloudBrowserClient();
      const { data } = await cloudClient.auth.getSession();
      const session = data.session;
      if (!session) {
        return null;
      }

      const metadata: Record<string, unknown> =
        session.user.user_metadata ?? {};
      const metadataString = (key: string) => {
        const value = metadata[key];
        return typeof value === "string" && value.trim() ? value.trim() : null;
      };

      const claims = await cloudClient.claims(session.access_token);
      if (claims.error) throw claims.error;
      return {
        userId: session.user.id,
        billing: deriveBillingInfo(claims.data),
        createdAt: session.user.created_at ?? null,
        email: session.user.email ?? null,
        profile: {
          // An explicit full_name (even cleared to null) wins; fall back to
          // the OAuth-provided name only when the user never set one.
          fullName:
            "full_name" in metadata
              ? metadataString("full_name")
              : metadataString("name"),
          linkedinUrl: metadataString("linkedin_url"),
          xHandle: metadataString("x_handle"),
          websiteUrl: metadataString("website_url"),
        },
      };
    },
  });
}
