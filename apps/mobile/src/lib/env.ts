import Constants from "expo-constants";

import { getShotsCloudUrl } from "@anlg/supabase/shots";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

const read = (key: string, fallback = ""): string => {
  const value = extra[key];
  return typeof value === "string" && value ? value : fallback;
};

const shotsUrl = read("shotsUrl");
const apiUrl = read("apiUrl", "https://api.anarlog.so");

export const env = {
  appVariant: read("appVariant", __DEV__ ? "dev" : "stable"),
  appScheme: read("appScheme", "anarlog"),
  shotsUrl,
  supabaseUrl: shotsUrl ? getShotsCloudUrl(apiUrl) : read("supabaseUrl"),
  supabaseAnonKey: shotsUrl ? "shots-founder-hub" : read("supabaseAnonKey"),
  apiUrl,
  appUrl: read("appUrl", "https://anarlog.so"),
  posthogApiKey: read("posthogApiKey"),
  posthogHost: read("posthogHost", "https://us.i.posthog.com"),
  sentryDsn: read("sentryDsn"),
};

export const hasSupabaseEnv = Boolean(env.supabaseUrl && env.supabaseAnonKey);
