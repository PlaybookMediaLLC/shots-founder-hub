import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";

import { createClient, type CloudClient } from "@anlg/cloud-client";

import { env, hasCloudEnv } from "@/lib/env";

const firstHostnameLabel = (url: string): string =>
  url
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .split(/[/:?#]/)[0]!
    .split(".")[0]!;

export const authStorageKey = `sb-${firstHostnameLabel(
  env.cloudUrl || "local",
)}-auth-token`;

export const cloudClient: CloudClient | null = hasCloudEnv
  ? createClient(env.cloudUrl, {
      auth: {
        storage: AsyncStorage,
        storageKey: authStorageKey,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;

if (cloudClient) {
  const client = cloudClient;
  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      void client.auth.startAutoRefresh();
    } else {
      void client.auth.stopAutoRefresh();
    }
  });
}
