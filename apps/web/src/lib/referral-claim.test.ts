import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "@anlg/cloud-client";

import { claimReferralCode } from "./referral-claim.ts";

function client(respond: () => Response) {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  return {
    requests,
    client: createClient("https://cloud.example.test", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          requests.push({ url: new URL(String(input)), init });
          return respond();
        },
      },
    }),
  };
}

test("referral claims send the new sign-in token and return the result", async () => {
  for (const result of [true, false]) {
    const fixture = client(() => Response.json(result));
    assert.equal(
      await claimReferralCode(fixture.client, "new-token", "a".repeat(24)),
      result,
    );
    const [request] = fixture.requests;
    assert.equal(request?.url.pathname, "/data/rpc/claim_referral");
    assert.equal(request?.init?.method, "POST");
    assert.equal(
      new Headers(request?.init?.headers).get("Authorization"),
      "Bearer new-token",
    );
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
      p_code: "a".repeat(24),
    });
  }
});

test("referral claim failures reject so the cookie stays for a retry", async () => {
  const fixture = client(() =>
    Response.json({ message: "unavailable" }, { status: 503 }),
  );
  await assert.rejects(
    claimReferralCode(fixture.client, "new-token", "a".repeat(24)),
  );
});
