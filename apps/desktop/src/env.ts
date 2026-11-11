import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

import { getShotsCloudUrl } from "@anlg/supabase/shots";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_APP_URL: z.string().min(1).default("http://localhost:3000"),
    VITE_API_URL: z.string().min(1).default("http://localhost:3001"),
    VITE_SHOTS_URL: z.string().url().optional(),
    VITE_STATIC_ASSETS_URL: z
      .string()
      .url()
      .default("https://static.anarlog.so"),
    VITE_AI_API_URL: z.string().url().optional(),
    VITE_ENTERPRISE_API_URL: z.string().url().optional(),
    VITE_SUPABASE_URL: z.string().min(1).optional(),
    VITE_SUPABASE_ANON_KEY: z.string().min(1).optional(),
    VITE_PRO_PRODUCT_ID: z.string().min(1).optional(),
    VITE_SENTRY_DSN: z.string().min(1).optional(),
    VITE_POSTHOG_API_KEY: z.string().min(1).optional(),
    VITE_POSTHOG_HOST: z.string().min(1).default("https://us.i.posthog.com"),
    VITE_APP_VERSION: z.string().min(1).optional(),
  },
  runtimeEnv: {
    ...import.meta.env,
    ...(import.meta.env.VITE_SHOTS_URL
      ? {
          VITE_SUPABASE_URL: getShotsCloudUrl(
            import.meta.env.VITE_API_URL || "http://localhost:3001",
          ),
          VITE_SUPABASE_ANON_KEY: "shots-founder-hub",
        }
      : {}),
  },
  emptyStringAsUndefined: true,
});
