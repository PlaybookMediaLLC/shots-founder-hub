import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: { base_url: "", api_key: "" },
  providerFetch: vi.fn(),
}));

vi.mock("~/env", () => ({
  env: {
    VITE_SHOTS_URL: "https://shots.test",
    VITE_API_URL: "https://hub.test",
  },
}));
vi.mock("~/auth", () => ({
  useAuth: () => ({
    session: { user: { id: "owner" } },
    getSessionForRequest: async () => ({
      user: { id: "owner" },
      access_token: "session-token",
    }),
  }),
}));
vi.mock("~/auth/billing-context", () => ({
  useBillingAccess: () => ({ isPaid: true, isPro: true }),
}));
vi.mock("~/auth/cloudsync-credentials", () => ({
  getDeviceIdentity: async () => ({ fingerprint: "desktop", name: "Mac" }),
}));
vi.mock("~/ai/hooks", () => ({ useLanguageModel: () => null }));
vi.mock("~/ai/provider-fetch", () => ({ providerFetch: mocks.providerFetch }));
vi.mock("~/settings/providers", () => ({
  getStoredAiProvider: async () => mocks.stored,
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => "1.0.0",
  getIdentifier: async () => "test.desktop",
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/home/test",
  downloadDir: async () => "/home/test/Downloads",
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@anlg/plugin-detect", () => ({
  commands: {
    listInstalledApplications: async () => ({ status: "ok", data: [] }),
    listDefaultIgnoredBundleIds: async () => ({ status: "ok", data: [] }),
  },
}));
vi.mock("@anlg/plugin-permissions", () => ({
  commands: {
    checkPermission: async () => ({ status: "ok", data: "authorized" }),
  },
}));
vi.mock("@anlg/plugin-transcription", () => ({
  commands: {
    listMicrophoneDevices: async () => ({ status: "ok", data: [] }),
  },
}));
vi.mock("~/lock/auth", () => ({ isDeviceAuthAvailable: async () => false }));
vi.mock("~/settings/ai/llm/shared", () => ({
  PROVIDERS: [
    { id: "apple_foundation", checkAvailability: async () => true },
    { id: "claude", baseUrl: "https://api.anthropic.com/v1" },
  ],
}));
vi.mock("~/settings/ai/shared", () => ({
  requiresKeyVerification: () => false,
}));
vi.mock("~/settings/ai/llm/select", () => ({
  getLlmProviderStatus: () => ({
    listModels: async () => ({ models: ["System Language Model"] }),
  }),
}));
vi.mock("./shots-private-action", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./shots-private-action")>();
  return {
    ...actual,
    openAIProviderRequest: async (_key: CryptoKey, argument: string) => ({
      value: actual.aiProviderRequestSchema.parse(JSON.parse(argument)),
      sealResult: async (value: unknown) =>
        JSON.stringify(actual.aiProviderResultSchema.parse(value)),
    }),
  };
});

import { useShotsDeviceSync } from "./shots-device-sync";

import { useAuth } from "~/auth";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.providerFetch.mockReset();
});

test.each([
  { provider: "apple_foundation", baseUrl: "", status: "succeeded" },
  { provider: "claude", baseUrl: "http://192.168.1.10/v1", status: "failed" },
])(
  "discovers native models but refuses insecure subscription endpoints: $provider",
  async ({ provider, baseUrl, status }) => {
    mocks.stored = { base_url: baseUrl, api_key: "saved-credential" };
    let completion: { status: string; result: string } | undefined;
    vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
      if (init.method === "PATCH") {
        completion = JSON.parse(String(init.body));
        return Response.json({});
      }
      return Response.json([
        {
          id: "discover-models",
          deviceId: "desktop",
          kind: "ai-provider",
          status: "running",
          argument: JSON.stringify({
            operation: "discover",
            type: "llm",
            providerId: provider,
          }),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ]);
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result, unmount } = renderHook(
      () => useShotsDeviceSync(useAuth()),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    try {
      await waitFor(
        () => {
          expect(result.current.error).toBeFalsy();
          expect(completion?.status).toBe(status);
        },
        { timeout: 5_000 },
      );
      if (status === "succeeded") {
        expect(JSON.parse(completion!.result).models).toEqual([
          "System Language Model",
        ]);
      } else {
        expect(completion?.result).toBe("");
      }
      expect(mocks.providerFetch).not.toHaveBeenCalled();
    } finally {
      unmount();
      client.clear();
    }
  },
  10_000,
);
