import { describe, expect, it, vi } from "vitest";

import { createShotsAuthorization, exchangeShotsCallback } from "./shots";

describe("Shots native authorization", () => {
  it("uses PKCE and keeps credentials out of the browser redirect", async () => {
    const pending = await createShotsAuthorization({
      shotsUrl: "https://shots.example",
      redirectUri: "anarlog://auth/callback",
    });
    const authorize = new URL(pending.url);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toHaveLength(43);
    expect(pending.url).not.toContain(pending.codeVerifier);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ access_token: "access", refresh_token: "refresh" }),
      );
    const callback = `anarlog://auth/callback?code=once&state=${pending.state}&iss=${encodeURIComponent(pending.issuer)}`;
    const tokens = await exchangeShotsCallback({
      callback,
      pending,
      gatewayUrl: "https://hub.example/cloud",
      fetch: fetcher,
    });
    expect(tokens).toEqual({
      access_token: "access",
      refresh_token: "refresh",
    });
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(
      "https://hub.example/cloud/auth/v1/token?grant_type=authorization_code",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      code: "once",
      code_verifier: pending.codeVerifier,
      redirect_uri: pending.redirectUri,
    });
    for (const invalid of [
      callback.replace(pending.state, "other-state"),
      callback.replace("anarlog:", "https:"),
      callback.replace(
        encodeURIComponent(pending.issuer),
        encodeURIComponent("https://attacker.example/api/auth"),
      ),
      callback + "&code=second",
    ]) {
      await expect(
        exchangeShotsCallback({
          callback: invalid,
          pending,
          gatewayUrl: "https://hub.example/cloud",
          fetch: async () => {
            throw new Error(
              "Credentials must not leave the client for an invalid callback.",
            );
          },
        }),
      ).rejects.toThrow("Invalid");
    }
  });
});
