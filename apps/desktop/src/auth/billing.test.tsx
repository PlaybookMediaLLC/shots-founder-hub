import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BillingProvider } from "./billing";
import { useBillingAccess } from "./billing-context";

const state = vi.hoisted(() => ({
  session: { access_token: "opaque-one", user: { id: "one" } } as {
    access_token: string;
    user: { id: string };
  } | null,
  claims: vi.fn(),
  settings: vi.fn(),
  open: vi.fn(),
  platform: "macos",
  provider: "",
  model: "",
}));
vi.mock("./auth-context", () => ({
  useAuth: () => ({ session: state.session }),
}));
vi.mock("./client", () => ({ cloudClient: { claims: state.claims } }));
vi.mock("@anlg/plugin-analytics", () => ({ commands: { event: vi.fn() } }));
vi.mock("@anlg/plugin-opener2", () => ({ commands: { openUrl: vi.fn() } }));
vi.mock("@anlg/plugin-windows", () => ({ openUrlWithInstruction: state.open }));
vi.mock("../shared/utils", () => ({
  buildWebAppUrl: async () => "https://hub.example/app/checkout",
}));
vi.mock("../shared/config/configure-paid-settings", () => ({
  configurePaidSettings: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => state.platform,
  arch: () => "aarch64",
}));
vi.mock("~/settings/queries", () => ({ setSettingValues: state.settings }));
vi.mock("~/shared/config", () => ({
  useConfigValues: () => ({
    current_llm_provider: "",
    current_stt_provider: state.provider,
    current_stt_model: state.model,
  }),
}));
function claims(sub: string, paid: boolean) {
  return {
    error: null,
    data: {
      sub,
      entitlements: paid ? ["hyprnote_pro"] : [],
      subscription_status: paid ? "active" : null,
    },
  };
}
function Probe() {
  const access = useBillingAccess();
  return (
    <button
      data-testid="access"
      data-ready={access.isReady}
      data-paid={access.isPaid}
      onClick={access.upgradeToPro}
    >
      Upgrade
    </button>
  );
}
function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <BillingProvider>
        <Probe />
      </BillingProvider>
    </QueryClientProvider>
  );
  const result = render(tree());
  return () => result.rerender(tree());
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.session = { access_token: "opaque-one", user: { id: "one" } };
  state.claims.mockResolvedValue(claims("one", true));
  state.platform = "macos";
  state.provider = "";
  state.model = "";
});
it("uses live claims for opaque access tokens", async () => {
  view();
  await waitFor(() =>
    expect(screen.getByTestId("access").dataset.paid).toBe("true"),
  );
  expect(state.claims).toHaveBeenCalledWith("opaque-one");
});
it("retains same-account access during refresh but removes it immediately on account switch", async () => {
  const rerender = view();
  await waitFor(() =>
    expect(screen.getByTestId("access").dataset.paid).toBe("true"),
  );
  const next = pending<ReturnType<typeof claims>>();
  state.claims.mockReturnValue(next.promise);
  state.session = { access_token: "rotated-one", user: { id: "one" } };
  rerender();
  expect(screen.getByTestId("access").dataset.paid).toBe("true");
  state.session = { access_token: "opaque-two", user: { id: "two" } };
  rerender();
  expect(screen.getByTestId("access").dataset.paid).toBe("false");
  expect(screen.getByTestId("access").dataset.ready).toBe("false");
  await act(async () => next.resolve(claims("two", false)));
  await waitFor(() =>
    expect(screen.getByTestId("access").dataset.ready).toBe("true"),
  );
});
it("does not repair paid settings when authority is unavailable", async () => {
  state.platform = "windows";
  state.provider = "apple_speech";
  state.model = "apple-speech";
  state.claims.mockResolvedValue({ data: null, error: new Error("offline") });
  view();
  await waitFor(() => expect(state.claims).toHaveBeenCalled());
  expect(screen.getByTestId("access").dataset.ready).toBe("false");
  expect(state.settings).not.toHaveBeenCalled();
});
it("repairs unsupported local transcription after live paid access is confirmed", async () => {
  state.platform = "windows";
  state.provider = "apple_speech";
  state.model = "apple-speech";
  view();
  await waitFor(() =>
    expect(state.settings).toHaveBeenCalledWith({
      current_stt_provider: "anarlog",
      current_stt_model: "cloud",
    }),
  );
});
it("opens the Shots billing handoff once while an upgrade is pending", async () => {
  const open = pending<void>();
  state.open.mockReturnValue(open.promise);
  view();
  fireEvent.click(screen.getByText("Upgrade"));
  fireEvent.click(screen.getByText("Upgrade"));
  await waitFor(() => expect(state.open).toHaveBeenCalledTimes(1));
  await act(async () => open.resolve());
});
