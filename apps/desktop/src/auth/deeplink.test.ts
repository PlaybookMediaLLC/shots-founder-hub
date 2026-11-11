import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginDesktopAuth,
  beginShotsDesktopAuth,
  consumeDesktopAuthState,
  createAuthCallbackHandler,
  installShotsDesktopAuthSession,
} from "./deeplink";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const callback = (
  access_token: string,
  refresh_token: string,
  state?: string,
) => ({
  access_token,
  refresh_token,
  state: state ?? null,
  code: null,
  raw_url: null,
});

describe("auth callback handling", () => {
  it("installs only the session matching a pending login and rejects replay", async () => {
    let session: string | undefined;
    const handle = createAuthCallbackHandler({
      setSessionFromTokens: async (access) => {
        session = access;
      },
    });
    expect(await handle(callback("attacker", "refresh"))).toBe(false);
    const state = beginDesktopAuth();
    expect(
      await handle(callback("attacker", "refresh", crypto.randomUUID())),
    ).toBe(false);
    expect(session).toBeUndefined();
    expect(await handle(callback("legitimate", "refresh", state))).toBe(true);
    expect(session).toBe("legitimate");
    expect(await handle(callback("attacker", "refresh", state))).toBe(false);
    expect(session).toBe("legitimate");
    const oldState = beginDesktopAuth(1_000);
    expect(consumeDesktopAuthState(oldState, 1_000 + 15 * 60 * 1_000 + 1)).toBe(
      false,
    );
    const replacedState = beginDesktopAuth();
    const newestState = beginDesktopAuth();
    expect(await handle(callback("stale", "refresh", replacedState))).toBe(
      false,
    );
    expect(await handle(callback("newest", "refresh", newestState))).toBe(true);
    expect(session).toBe("newest");
  });
  it("allows a failed installation to retry while blocking concurrent and completed replays", async () => {
    const state = beginDesktopAuth();
    let reject: ((error: Error) => void) | undefined;
    let installed = false;
    const handle = createAuthCallbackHandler({
      setSessionFromTokens: async () => {
        if (!reject)
          await new Promise<void>((_resolve, fail) => {
            reject = fail;
          });
        installed = true;
      },
    });
    const first = handle(callback("access", "refresh", state));
    expect(await handle(callback("access", "refresh", state))).toBe(false);
    reject!(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    expect(await handle(callback("access", "refresh", state))).toBe(true);
    expect(installed).toBe(true);
    expect(await handle(callback("access", "refresh", state))).toBe(false);
  });

  it("installs native Shots code callbacks with issuer validation instead of accepting legacy tokens", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const authorization = new URL(
      await beginShotsDesktopAuth(
        "https://shots.example",
        "anarlog-dev://auth/callback",
      ),
    );
    const state = authorization.searchParams.get("state")!;
    const raw_url = `anarlog-dev://auth/callback?code=shots-code&state=${state}&iss=${encodeURIComponent("https://shots.example/api/auth")}`;
    let session: string | undefined;
    const handle = createAuthCallbackHandler({
      setSessionFromTokens: async (access) => {
        session = access;
      },
      handleShotsCallback: async (url) => {
        const installed = await installShotsDesktopAuthSession(
          url,
          "https://hub.example/cloud",
          async () =>
            Response.json({
              access_token: "shots-session",
              refresh_token: "refresh",
            }),
          async (access) => {
            session = access;
          },
        );
        if (!installed) throw new Error("Callback rejected");
      },
    });
    expect(await handle(callback("injected-session", "refresh", state))).toBe(
      false,
    );
    expect(session).toBeUndefined();
    const search = { ...callback("", "", state), code: "shots-code", raw_url };
    await expect(
      handle({
        ...search,
        raw_url: raw_url.replace("shots.example", "attacker.example"),
      }),
    ).rejects.toThrow("Invalid");
    expect(session).toBeUndefined();
    expect(await handle(search)).toBe(true);
    expect(session).toBe("shots-session");
  });
});
