import assert from "node:assert/strict";
import test from "node:test";

import { createShotsAuthorization } from "@anlg/supabase/shots";

import { consumeAuthCallback, pendingAuthStorageKey } from "./auth-callback.ts";
import { buildSignInUrl } from "./sign-in.ts";

test("Shots mobile login exchanges only the pending PKCE code and rejects legacy token injection", async () => {
  const pending = await createShotsAuthorization({
    shotsUrl: "https://shots.example",
    redirectUri: "anarlog://auth/callback",
  });
  let value = JSON.stringify({ ...pending, createdAt: 1_000 });
  const storage = {
    getItem: async () => value,
    removeItem: async () => {
      value = null;
    },
  };
  let installed = null;
  const consume = (url) =>
    consumeAuthCallback({
      url,
      scheme: "anarlog",
      storage,
      now: 1_001,
      shots: {
        gatewayUrl: "https://hub.example/cloud",
        fetch: async (url, request) => {
          assert.equal(
            url,
            "https://hub.example/cloud/auth/v1/token?grant_type=authorization_code",
          );
          assert.deepEqual(JSON.parse(request.body), {
            code: "one-time",
            code_verifier: pending.codeVerifier,
            redirect_uri: pending.redirectUri,
          });
          return Response.json({
            access_token: "shots-access",
            refresh_token: "shots-refresh",
          });
        },
      },
      installSession: async (tokens) => {
        installed = tokens;
        return true;
      },
    });
  const callback = `anarlog://auth/callback?code=one-time&state=${pending.state}&iss=${encodeURIComponent(pending.issuer)}`;
  assert.equal(await consume(callback.replace(pending.state, "other")), null);
  assert.equal(
    await consume(
      `anarlog://auth/callback?access_token=foreign&refresh_token=foreign&state=${pending.state}`,
    ),
    null,
  );
  assert.equal(installed, null);
  const results = await Promise.all([consume(callback), consume(callback)]);
  assert.deepEqual(results, [
    { accessToken: "shots-access", refreshToken: "shots-refresh" },
    null,
  ]);
  assert.deepEqual(installed, results[0]);
});

test("mobile accepts only the pending login once, including duplicate delivery and expired callbacks", async () => {
  const state = "8d58e770-3a95-41ba-bfa1-ec03633a3a55";
  const values = new Map([
    [pendingAuthStorageKey, JSON.stringify({ state, createdAt: 1_000 })],
  ]);
  const storage = {
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  const callback = `anarlog://auth/callback?access_token=access&refresh_token=refresh&state=${state}`;
  const consume = (url, now = 1_000) =>
    consumeAuthCallback({ url, scheme: "anarlog", storage, now });
  const signIn = new URL(
    buildSignInUrl("https://anarlog.so", "google", "anarlog", state),
  );
  assert.equal(signIn.searchParams.get("desktop_state"), state);
  assert.equal(await consume(callback.replace(`&state=${state}`, "")), null);
  assert.equal(await consume(callback.replace(state, "forged")), null);
  assert.equal(await consume(callback.replace("anarlog:", "attacker:")), null);
  assert.equal(await consume(callback, 15 * 60 * 1_000 + 1_001), null);
  const results = await Promise.all([consume(callback), consume(callback)]);
  assert.deepEqual(results, [
    { accessToken: "access", refreshToken: "refresh" },
    null,
  ]);
  assert.equal(await consume(callback), null);
});

test("queued mobile callbacks survive a stale URL and a failed session installation", async () => {
  const state = "8d58e770-3a95-41ba-bfa1-ec03633a3a55";
  let pending = JSON.stringify({ state, createdAt: 1_000 });
  let release;
  let started;
  const reading = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let firstRead = true;
  const storage = {
    getItem: async () => {
      if (firstRead) {
        firstRead = false;
        started();
        await gate;
      }
      return pending;
    },
    removeItem: async () => {
      pending = null;
    },
  };
  const callback = `anarlog://auth/callback?access_token=access&refresh_token=refresh&state=${state}`;
  let available = false;
  let session = null;
  const consume = (url) =>
    consumeAuthCallback({
      url,
      scheme: "anarlog",
      storage,
      now: 1_000,
      installSession: async (tokens) => {
        if (!available) return false;
        session = tokens.accessToken;
        return true;
      },
    });
  const stale = consume(callback.replace(state, "stale"));
  await reading;
  const valid = consume(callback);
  release();
  assert.equal(await stale, null);
  assert.equal(await valid, null);
  assert.notEqual(pending, null);
  available = true;
  assert.deepEqual(await consume(callback), {
    accessToken: "access",
    refreshToken: "refresh",
  });
  assert.equal(session, "access");
  assert.equal(await consume(callback), null);
});
