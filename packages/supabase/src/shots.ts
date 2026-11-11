function secureUrl(value: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Shots authentication requires HTTPS or a local development server.",
    );
  }
  return url;
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function getShotsCloudUrl(apiUrl: string) {
  const url = secureUrl(apiUrl);
  url.pathname = url.pathname.replace(/\/$/, "") + "/cloud";
  return url.toString();
}

export function getShotsSettingsUrl(
  shotsUrl: string,
  userId: string,
  section: "account" | "members" | "billing" | "security" | "crm" | "referrals",
) {
  if (typeof userId !== "string" || !userId || userId.length > 160) {
    throw new Error("Sign in to Shots to manage your account.");
  }
  const url = new URL("/founder-hub/manage", secureUrl(shotsUrl));
  url.search = new URLSearchParams({ user: userId, section }).toString();
  return url.toString();
}

export async function createShotsAuthorization({
  shotsUrl,
  redirectUri,
  switchAccount = false,
  crypto: cryptoProvider = {
    randomUUID: () => globalThis.crypto.randomUUID(),
    randomBytes: (length: number) =>
      globalThis.crypto.getRandomValues(new Uint8Array(length)),
    digest: (value: ArrayBuffer) =>
      globalThis.crypto.subtle.digest("SHA-256", value),
  },
}: {
  shotsUrl: string;
  redirectUri: string;
  switchAccount?: boolean;
  crypto?: {
    randomUUID: () => string;
    randomBytes: (length: number) => Uint8Array;
    digest: (value: ArrayBuffer) => Promise<ArrayBuffer>;
  };
}) {
  const origin = secureUrl(shotsUrl);
  const state = cryptoProvider.randomUUID();
  const codeVerifier = base64url(cryptoProvider.randomBytes(32));
  const challenge = base64url(
    new Uint8Array(
      await cryptoProvider.digest(
        new TextEncoder().encode(codeVerifier).buffer,
      ),
    ),
  );
  const url = new URL("/api/auth/oauth2/authorize", origin);
  url.search = new URLSearchParams({
    client_id: "shots-founder-hub",
    response_type: "code",
    scope: "openid profile email offline_access founder-hub",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(switchAccount ? { prompt: "login" } : {}),
  }).toString();
  return {
    url: url.toString(),
    state,
    codeVerifier,
    redirectUri,
    issuer: new URL("/api/auth", origin).toString(),
  };
}

export async function exchangeShotsCallback({
  callback,
  pending,
  gatewayUrl,
  fetch: fetcher = fetch,
}: {
  callback: string;
  pending: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    issuer: string;
  };
  gatewayUrl: string;
  fetch?: typeof fetch;
}) {
  const url = new URL(callback);
  const redirect = new URL(pending.redirectUri);
  const code = url.searchParams.get("code");
  if (
    url.protocol !== redirect.protocol ||
    url.host !== redirect.host ||
    url.pathname !== redirect.pathname ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.get("state") !== pending.state ||
    url.searchParams.get("iss") !== pending.issuer ||
    !code ||
    ["code", "state", "iss"].some(
      (key) => url.searchParams.getAll(key).length !== 1,
    ) ||
    url.searchParams.has("access_token") ||
    url.searchParams.has("refresh_token")
  ) {
    throw new Error(
      "Invalid or expired sign-in callback. Start sign-in again.",
    );
  }
  const endpoint = secureUrl(gatewayUrl);
  endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/auth/v1/token";
  endpoint.searchParams.set("grant_type", "authorization_code");
  const response = await fetcher(endpoint.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: pending.codeVerifier,
      redirect_uri: pending.redirectUri,
    }),
  });
  if (!response.ok)
    throw new Error("Could not complete sign-in. Start sign-in again.");
  const tokens: unknown = await response.json();
  if (
    !tokens ||
    typeof tokens !== "object" ||
    !("access_token" in tokens) ||
    typeof tokens.access_token !== "string" ||
    !("refresh_token" in tokens) ||
    typeof tokens.refresh_token !== "string" ||
    !tokens.access_token ||
    !tokens.refresh_token
  )
    throw new Error("The sign-in server returned an invalid session.");
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  };
}
