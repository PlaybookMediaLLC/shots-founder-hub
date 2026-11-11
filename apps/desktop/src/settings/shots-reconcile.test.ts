import { describe, expect, it } from "vitest";

import { reconcileSettings, SettingsConflict } from "./shots-reconcile";

describe("Shots settings reconciliation", () => {
  it("imports existing preferences once, merges independent offline edits, and preserves conflicts", () => {
    expect(
      reconcileSettings({
        local: { theme: "dark", autostart: true },
        baseline: null,
        remote: { theme: "light" },
      }).patch,
    ).toEqual({ autostart: true });
    const change = {
      local: { theme: "dark", autostart: false },
      baseline: { theme: "light", autostart: false },
      remote: { theme: "light", autostart: true },
    } as const;
    expect(reconcileSettings(change)).toEqual({
      patch: { theme: "dark" },
      next: { theme: "dark", autostart: true },
    });
    const conflict = {
      ...change,
      remote: { theme: "system", autostart: true },
    } as const;
    expect(() => reconcileSettings(conflict)).toThrow(SettingsConflict);
    expect(
      reconcileSettings({ ...conflict, resolution: "shots" }).next.theme,
    ).toBe("system");
    expect(
      reconcileSettings({ ...conflict, resolution: "desktop" }).patch.theme,
    ).toBe("dark");
    expect(
      reconcileSettings({
        local: { autostart: false },
        baseline: {},
        remote: {},
      }).patch,
    ).toEqual({});
  });
});
