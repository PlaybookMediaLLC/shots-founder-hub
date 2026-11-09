import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  billing: {
    isPro: true,
    isUpgradingToPro: false,
    upgradeToPro: vi.fn(),
  },
  toastWarning: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (
      input: TemplateStringsArray | { message?: string } | string,
      ...values: unknown[]
    ) => {
      if (typeof input === "string") return input;
      if (Array.isArray(input)) {
        return (input as readonly string[]).reduce(
          (message: string, part: string, index: number) =>
            `${message}${part}${index < values.length ? String(values[index]) : ""}`,
          "",
        );
      }
      return (input as { message?: string }).message ?? "";
    },
  }),
}));

vi.mock("~/settings/queries", () => ({
  useSetSettingValue: () => vi.fn(),
}));

vi.mock("~/auth/billing-context", () => ({
  useBillingAccess: () => mocks.billing,
}));

vi.mock("@anlg/ui/components/ui/toast", () => ({
  toast: { warning: mocks.toastWarning },
}));

vi.mock("~/shared/config", () => ({
  useConfigValue: () => [],
}));

import { DictionarySettings, SettingsDictionary } from "./index";

describe("DictionarySettings", () => {
  beforeEach(() => {
    mocks.billing.isPro = true;
    mocks.billing.isUpgradingToPro = false;
    mocks.billing.upgradeToPro.mockClear();
    mocks.toastWarning.mockClear();
  });

  afterEach(cleanup);

  it("shows the dictionary editor and toasts on the free plan", () => {
    mocks.billing.isPro = false;

    render(<SettingsDictionary />);

    expect(screen.getByRole("textbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("textbox"));

    expect(mocks.toastWarning).toHaveBeenCalledWith(
      "This requires Shots Founder Hub Pro",
      {
        action: {
          label: "Upgrade",
          onClick: expect.any(Function),
        },
      },
    );
    expect(mocks.billing.upgradeToPro).not.toHaveBeenCalled();
  });

  it("adds entered terms and keeps them normalized", async () => {
    const onSave = vi.fn();
    render(
      <DictionarySettings terms={["Shots Founder Hub"]} onSave={onSave} />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: " FastConformer, Parakeet TDT " },
    });
    const addButton = screen.getByRole("button", {
      name: "Add",
    }) as HTMLButtonElement;
    await waitFor(() => expect(addButton.disabled).toBe(false));
    fireEvent.click(addButton);

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        JSON.stringify(["Shots Founder Hub", "FastConformer", "Parakeet TDT"]),
      ),
    );
  });

  it("removes saved terms", () => {
    const onSave = vi.fn();
    render(
      <DictionarySettings
        terms={["Shots Founder Hub", "Parakeet TDT"]}
        onSave={onSave}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Shots Founder Hub" }),
    );

    expect(onSave).toHaveBeenCalledWith(JSON.stringify(["Parakeet TDT"]));
  });

  it("edits saved terms inline", () => {
    const onSave = vi.fn();
    render(
      <DictionarySettings
        terms={["Shots Founder Hub", "Parakeet TDT"]}
        onSave={onSave}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit: Shots Founder Hub" }),
    );
    const input = screen.getByRole("textbox", {
      name: "Edit: Shots Founder Hub",
    });
    fireEvent.change(input, { target: { value: " Shots Founder Hub AI " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(
      JSON.stringify(["Shots Founder Hub AI", "Parakeet TDT"]),
    );
  });

  it("does not save an edit that duplicates another term", () => {
    const onSave = vi.fn();
    render(
      <DictionarySettings
        terms={["Shots Founder Hub", "Parakeet TDT"]}
        onSave={onSave}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit: Shots Founder Hub" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Edit: Shots Founder Hub" }),
      {
        target: { value: "parakeet tdt" },
      },
    );

    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("cancels inline edits with Escape", () => {
    const onSave = vi.fn();
    render(
      <DictionarySettings terms={["Shots Founder Hub"]} onSave={onSave} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit: Shots Founder Hub" }),
    );
    const input = screen.getByRole("textbox", {
      name: "Edit: Shots Founder Hub",
    });
    fireEvent.change(input, { target: { value: "Shots Founder Hub AI" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.getByText("Shots Founder Hub")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not enable adding duplicate terms", async () => {
    const onSave = vi.fn();
    render(
      <DictionarySettings terms={["Shots Founder Hub"]} onSave={onSave} />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "shots founder hub" },
    });

    const addButton = screen.getByRole("button", {
      name: "Add",
    }) as HTMLButtonElement;
    await waitFor(() => expect(addButton.disabled).toBe(true));
    fireEvent.click(addButton);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("filters saved terms while typing", async () => {
    render(
      <DictionarySettings
        terms={["Shots Founder Hub", "FastConformer", "Parakeet TDT"]}
        onSave={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "fast" },
    });

    await waitFor(() => expect(screen.getByText("FastConformer")).toBeTruthy());
    expect(screen.queryByText("Shots Founder Hub")).toBeNull();
    expect(screen.queryByText("Parakeet TDT")).toBeNull();
  });
});
