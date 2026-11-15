import { expect, it } from "vitest";

import { createClient, type Session } from "./client";

const user = {
  id: "user",
  email: "test@example.test",
  aud: "authenticated",
  created_at: "2026-01-01",
  app_metadata: {},
  user_metadata: {},
};
const session: Session = {
  access_token: "opaque-access",
  refresh_token: "opaque-refresh",
  token_type: "bearer",
  expires_in: 3600,
  user,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("keeps rotated opaque tokens and reads claims from the authority", async () => {
  const client = createClient("https://api.example.test/cloud", {
    global: {
      fetch: async (url, init) => {
        if (String(url).includes("/token?"))
          return Response.json({ ...session, access_token: "rotated" });
        if (String(url).endsWith("/claims")) {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer rotated",
          );
          return Response.json({
            sub: user.id,
            entitlements: ["hyprnote_pro"],
          });
        }
        return Response.json(user);
      },
    },
  });
  expect((await client.auth.setSession(session)).error).toBeNull();
  expect((await client.auth.refreshSession()).data.session?.access_token).toBe(
    "rotated",
  );
  expect((await client.claims()).data?.entitlements).toEqual(["hyprnote_pro"]);
});

it("does not resurrect a session when a user lookup returns after sign-out", async () => {
  const response = deferred<Response>();
  let delay = false;
  const client = createClient("https://api.example.test/cloud", {
    global: {
      fetch: async (url) => {
        if (String(url).includes("/logout?"))
          return new Response(null, { status: 204 });
        return delay ? response.promise : Response.json(user);
      },
    },
  });
  await client.auth.setSession(session);
  delay = true;
  const lookup = client.auth.getUser();
  await client.auth.signOut();
  response.resolve(Response.json(user));
  await lookup;
  expect((await client.auth.getSession()).data.session).toBeNull();
});

it("does not save an in-flight refresh after sign-out begins", async () => {
  const response = deferred<Response>();
  const started = deferred<void>();
  const client = createClient("https://api.example.test/cloud", {
    global: {
      fetch: async (url) => {
        if (String(url).includes("/token?")) {
          started.resolve();
          return response.promise;
        }
        if (String(url).includes("/logout?"))
          return new Response(null, { status: 204 });
        return Response.json(user);
      },
    },
  });
  await client.auth.setSession(session);
  const refresh = client.auth.refreshSession();
  await started.promise;
  const logout = client.auth.signOut();
  response.resolve(Response.json({ ...session, access_token: "rotated" }));
  expect((await refresh).error?.code).toBe("session_not_found");
  await logout;
  expect((await client.auth.getSession()).data.session).toBeNull();
});

it("retains the session on transient refresh failure and rejects malformed success payloads", async () => {
  let response = Response.json(user);
  const client = createClient("https://api.example.test/cloud", {
    global: { fetch: async () => response.clone() },
  });
  await client.auth.setSession(session);
  response = new Response("unavailable", { status: 503 });
  expect((await client.auth.refreshSession()).error?.status).toBe(503);
  expect((await client.auth.getSession()).data.session?.refresh_token).toBe(
    "opaque-refresh",
  );
  response = new Response("invalid-json", { status: 200 });
  expect((await client.claims()).error).not.toBeNull();
});

it("rejects malformed users and session expiries without replacing a valid session", async () => {
  let payload: unknown = user;
  const client = createClient("https://api.example.test/cloud", {
    global: { fetch: async () => Response.json(payload) },
  });
  await client.auth.setSession(session);
  for (const invalid of [
    {},
    { ...user, id: "" },
    { ...user, identities: {} },
    { ...user, user_metadata: null },
  ]) {
    payload = invalid;
    expect((await client.auth.setSession(session)).error).not.toBeNull();
    expect((await client.auth.getUser()).error).not.toBeNull();
  }
  for (const invalid of [
    { ...session, expires_at: "tomorrow" },
    { ...session, expires_in: -1 },
    { ...session, user: {} },
  ]) {
    payload = invalid;
    expect((await client.auth.refreshSession()).error).not.toBeNull();
  }
  expect((await client.auth.getSession()).data.session?.user.id).toBe(user.id);
});
