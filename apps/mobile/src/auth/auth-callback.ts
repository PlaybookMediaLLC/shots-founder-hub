export const pendingAuthStorageKey = "anarlog:auth:pending-handoff";
let callbackQueue: Promise<unknown> = Promise.resolve();

async function checkAuthCallback({
  url,
  scheme,
  storage,
  now = Date.now(),
  installSession,
  shots,
}: {
  url: string;
  scheme: string;
  storage: {
    getItem: (key: string) => Promise<string | null>;
    removeItem: (key: string) => Promise<void>;
  };
  now?: number;
  shots?: { gatewayUrl: string; fetch?: typeof fetch };
  installSession?: (tokens: {
    accessToken: string;
    refreshToken: string;
  }) => Promise<boolean>;
}) {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== `${scheme}:` ||
      parsed.hostname !== "auth" ||
      parsed.pathname !== "/callback"
    )
      return null;
    const accessToken = parsed.searchParams.get("access_token");
    const refreshToken = parsed.searchParams.get("refresh_token");
    const state = parsed.searchParams.get("state");
    if (!state || (!shots && (!accessToken || !refreshToken))) return null;
    const raw = await storage.getItem(pendingAuthStorageKey);
    if (!raw) return null;
    const pending = JSON.parse(raw);
    if (
      pending.state !== state ||
      typeof pending.createdAt !== "number" ||
      now < pending.createdAt ||
      now - pending.createdAt > 15 * 60 * 1_000
    )
      return null;
    let tokens;
    if (shots) {
      if (
        typeof pending.codeVerifier !== "string" ||
        typeof pending.redirectUri !== "string" ||
        typeof pending.issuer !== "string"
      )
        return null;
      const exchanged = await exchangeShotsCallback({
        callback: url,
        pending,
        ...shots,
      });
      tokens = {
        accessToken: exchanged.access_token,
        refreshToken: exchanged.refresh_token,
      };
    } else {
      if (!accessToken || !refreshToken) return null;
      tokens = { accessToken, refreshToken };
    }
    if (installSession && !(await installSession(tokens))) return null;
    if ((await storage.getItem(pendingAuthStorageKey)) === raw)
      await storage.removeItem(pendingAuthStorageKey);
    return tokens;
  } catch {
    return null;
  }
}

export function consumeAuthCallback(
  options: Parameters<typeof checkAuthCallback>[0],
) {
  const next = callbackQueue
    .catch(() => {})
    .then(() => checkAuthCallback(options));
  callbackQueue = next;
  return next;
}
import { exchangeShotsCallback } from "@anlg/supabase/shots";
