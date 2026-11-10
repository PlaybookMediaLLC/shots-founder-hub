import type { AuthCallbackSearch } from "@anlg/plugin-deeplink2";

const PENDING_AUTH_KEY = "anarlog.pending-desktop-auth";
const installingStates = new Set<string>();
const PENDING_AUTH_MAX_AGE_MS = 15 * 60 * 1000;

export async function beginShotsDesktopAuth(
  shotsUrl: string,
  redirectUri: string,
  switchAccount = false,
) {
  const pending = await createShotsAuthorization({
    shotsUrl,
    redirectUri,
    switchAccount,
  });
  localStorage.setItem(
    PENDING_AUTH_KEY,
    JSON.stringify({ ...pending, createdAt: Date.now() }),
  );
  return pending.url;
}

export async function installShotsDesktopAuthSession(
  callback: string,
  gatewayUrl: string,
  fetcher: typeof fetch,
  install: (accessToken: string, refreshToken: string) => Promise<void>,
) {
  const state = new URL(callback).searchParams.get("state");
  const stored = pendingDesktopAuthState(state);
  if (!stored || !state || installingStates.has(state)) return false;
  const pending = JSON.parse(stored);
  if (
    typeof pending.codeVerifier !== "string" ||
    typeof pending.redirectUri !== "string" ||
    typeof pending.issuer !== "string"
  )
    return false;
  installingStates.add(state);
  try {
    const tokens = await exchangeShotsCallback({
      callback,
      pending,
      gatewayUrl,
      fetch: fetcher,
    });
    await install(tokens.access_token, tokens.refresh_token);
    if (localStorage.getItem(PENDING_AUTH_KEY) === stored)
      localStorage.removeItem(PENDING_AUTH_KEY);
    return true;
  } finally {
    installingStates.delete(state);
  }
}

export function beginDesktopAuth(now = Date.now()) {
  const state = crypto.randomUUID();
  localStorage.setItem(
    PENDING_AUTH_KEY,
    JSON.stringify({ state, createdAt: now }),
  );
  return state;
}

function pendingDesktopAuthState(
  state: string | null | undefined,
  now = Date.now(),
) {
  if (!state) return false;
  try {
    const stored = localStorage.getItem(PENDING_AUTH_KEY);
    if (!stored) return false;
    const pending = JSON.parse(stored);
    if (
      pending.state !== state ||
      typeof pending.createdAt !== "number" ||
      now < pending.createdAt ||
      now - pending.createdAt > PENDING_AUTH_MAX_AGE_MS
    )
      return false;
    return stored;
  } catch {
    return false;
  }
}

export function consumeDesktopAuthState(
  state: string | null | undefined,
  now = Date.now(),
) {
  if (!pendingDesktopAuthState(state, now)) return false;
  localStorage.removeItem(PENDING_AUTH_KEY);
  return true;
}

export async function installDesktopAuthSession(
  accessToken: string,
  refreshToken: string,
  state: string | null | undefined,
  install: (accessToken: string, refreshToken: string) => Promise<void>,
) {
  if (!accessToken || !refreshToken || !state || installingStates.has(state))
    return false;
  const pending = pendingDesktopAuthState(state);
  if (!pending) return false;
  installingStates.add(state);
  try {
    await install(accessToken, refreshToken);
    if (localStorage.getItem(PENDING_AUTH_KEY) === pending)
      localStorage.removeItem(PENDING_AUTH_KEY);
    return true;
  } finally {
    installingStates.delete(state);
  }
}

export function createAuthCallbackHandler({
  setSessionFromTokens,
  handleShotsCallback,
}: {
  setSessionFromTokens: (
    accessToken: string,
    refreshToken: string,
  ) => Promise<void>;
  handleShotsCallback?: (url: string) => Promise<void>;
}) {
  return async (search: AuthCallbackSearch) => {
    if (handleShotsCallback) {
      if (!search.code || !search.raw_url) return false;
      await handleShotsCallback(search.raw_url);
      return true;
    }
    return installDesktopAuthSession(
      search.access_token ?? "",
      search.refresh_token ?? "",
      search.state ?? undefined,
      setSessionFromTokens,
    );
  };
}
import {
  createShotsAuthorization,
  exchangeShotsCallback,
} from "@anlg/supabase/shots";
