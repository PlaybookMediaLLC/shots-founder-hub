import Constants from "expo-constants";

import { getShotsCloudUrl } from "@anlg/cloud-client/shots";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

const read = (key: string, fallback = ""): string => {
  const value = extra[key];
  return typeof value === "string" && value ? value : fallback;
};

const shotsUrl = read("shotsUrl");
const apiUrl = read("apiUrl", "https://founder-hub-api.shots.playbookmedia.io");

export const env = {
  appVariant: read("appVariant", __DEV__ ? "dev" : "stable"),
  appScheme: read("appScheme", "anarlog"),
  shotsUrl,
  cloudUrl: getShotsCloudUrl(apiUrl),
  r2DownloadBaseUrl: read("r2DownloadBaseUrl"),
  apiUrl,
  appUrl: read("appUrl", "https://shots.playbookmedia.io"),
  posthogApiKey: read("posthogApiKey"),
  posthogHost: read("posthogHost", "https://us.i.posthog.com"),
  sentryDsn: read("sentryDsn"),
};

export const hasCloudEnv = Boolean(env.shotsUrl && env.cloudUrl);
