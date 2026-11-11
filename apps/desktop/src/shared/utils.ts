import { getIdentifier } from "@tauri-apps/api/app";

import { getShotsSettingsUrl } from "@anlg/supabase/shots";

import { beginDesktopAuth } from "~/auth/deeplink";
import { env } from "~/env";

// export * from "../shared/config/configure-pro-settings";
// export * from "~/sidebar/timeline/utils";
// export * from "~/stt/segment";

export const id = () => crypto.randomUUID() as string;

export type DesktopScheme =
  | "anarlog"
  | "anarlog-staging"
  | "anarlog-nightly"
  | "anarlog-dev";

export const getScheme = async (): Promise<DesktopScheme> => {
  const id = await getIdentifier();
  const schemes: Record<string, DesktopScheme> = {
    "com.hyprnote.stable": "anarlog",
    "com.hyprnote.Hyprnote": "anarlog",
    "com.hyprnote.staging": "anarlog-staging",
    "com.hyprnote.nightly": "anarlog-nightly",
    "com.hyprnote.dev": "anarlog-dev",
    "so.anarlog.Anarlog": "anarlog",
    "com.anarlog.stable": "anarlog",
    "com.anarlog.staging": "anarlog-staging",
    "com.anarlog.dev": "anarlog-dev",
  };
  if (typeof id === "string" && id.startsWith("com.hyprnote.dev."))
    return "anarlog-dev";
  return schemes[id] ?? "anarlog";
};

type DesktopFlowPath =
  | "/app/google-drive-picker"
  | "/auth"
  | "/app/account"
  | "/app/crm"
  | "/app/referrals"
  | "/app/team"
  | "/app/integration"
  | "/app/checkout"
  | "/app/team-checkout"
  | "/app/switch-plan"
  | "/app/portal";

export const buildWebAppUrl = async (
  path: DesktopFlowPath,
  params?: Record<string, string>,
): Promise<string> => {
  if (
    env.VITE_SHOTS_URL &&
    [
      "/app/account",
      "/app/crm",
      "/app/referrals",
      "/app/team",
      "/app/checkout",
      "/app/team-checkout",
      "/app/switch-plan",
      "/app/portal",
    ].includes(path)
  ) {
    const { supabase } = await import("~/auth/client");
    const result = await supabase?.auth.getSession();
    if (result?.error) throw result.error;
    const userId = result?.data.session?.user.app_metadata.shots_user_id;
    if (typeof userId !== "string")
      throw new Error("Sign in to Shots to manage your account.");
    return getShotsSettingsUrl(
      env.VITE_SHOTS_URL,
      userId,
      path === "/app/account"
        ? "account"
        : path === "/app/team"
          ? "members"
          : path === "/app/crm"
            ? "crm"
            : path === "/app/referrals"
              ? "referrals"
              : "billing",
    );
  }
  const scheme = await getScheme();
  const url = new URL(path, env.VITE_APP_URL);
  url.searchParams.set("flow", "desktop");
  url.searchParams.set("scheme", scheme);
  if (
    import.meta.env.DEV &&
    scheme === "anarlog-dev" &&
    (path === "/app/integration" || path === "/app/google-drive-picker")
  ) {
    const { commands } = await import("@anlg/plugin-deeplink2");
    const callback = await commands.startCallbackServer(scheme, null);
    if (callback.status === "error") throw new Error(callback.error);
    url.searchParams.set("callback_port", String(callback.data));
  }
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  if (path === "/auth") {
    url.searchParams.set("desktop_state", beginDesktopAuth());
  }
  return url.toString();
};

// https://www.rfc-editor.org/rfc/rfc4122#section-4.1.7
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000000";

export const DEVICE_FINGERPRINT_HEADER = "x-device-fingerprint";
export const REQUEST_ID_HEADER = "x-request-id";
export const CHAR_TASK_HEADER = "x-char-task";
