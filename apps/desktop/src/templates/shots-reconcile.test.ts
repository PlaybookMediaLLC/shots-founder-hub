import { describe, expect, it } from "vitest";

import {
  planTemplateSync,
  TemplateConflict,
  type ShotsTemplate,
} from "./shots-reconcile";

const template: ShotsTemplate = {
  id: "default-meeting",
  title: "Meeting",
  description: "",
  category: "",
  icon: { type: "emoji", value: "📝" },
  targets: [],
  sections: [{ title: "Summary", description: "" }],
  pinned: false,
  pinOrder: null,
  version: 1,
  seeded: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
};

describe("Shots template reconciliation", () => {
  it("preserves offline edits and deletions without overwriting an independently edited server template", () => {
    const local = {
      ...template,
      title: "Offline edit",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    expect(
      planTemplateSync({
        local: [
          {
            ...template,
            updatedAt: new Date(template.updatedAt).toISOString(),
          },
        ],
        remote: [template],
        baseline: [template],
      }),
    ).toEqual([]);
    expect(
      planTemplateSync({ local: [], remote: [template], baseline: [] })[0]
        .upload,
    ).toBe(true);
    expect(
      planTemplateSync({ local: [local], remote: [template], baseline: [] })[0]
        .upload,
    ).toBe(true);
    const server = {
      ...template,
      seeded: false,
      version: 2,
      title: "Browser edit",
    };
    expect(() =>
      planTemplateSync({
        local: [local],
        remote: [server],
        baseline: [template],
      }),
    ).toThrow(TemplateConflict);
    expect(
      planTemplateSync({
        local: [template],
        remote: [server],
        baseline: [template],
      })[0].upload,
    ).toBe(false);
    expect(
      planTemplateSync({
        local: [local],
        remote: [template],
        baseline: [template],
      })[0].upload,
    ).toBe(true);
    const deleted = { ...server, deletedAt: "2026-01-03T00:00:00Z" };
    const resolution = (remote: ShotsTemplate, choice: "desktop" | "shots") => {
      try {
        planTemplateSync({
          local: [local],
          remote: [remote],
          baseline: [template],
        });
      } catch (error) {
        if (error instanceof TemplateConflict)
          return { choice, snapshots: error.snapshots };
        throw error;
      }
      throw new Error("Expected a conflict");
    };
    expect(
      planTemplateSync({
        local: [local],
        remote: [deleted],
        baseline: [template],
        resolution: resolution(deleted, "desktop"),
      })[0].copy,
    ).toBe(true);
    expect(
      planTemplateSync({
        local: [local],
        remote: [server],
        baseline: [template],
        resolution: resolution(server, "shots"),
      })[0].upload,
    ).toBe(false);
    expect(() =>
      planTemplateSync({
        local: [local],
        remote: [{ ...server, version: 3, title: "A newer change" }],
        baseline: [template],
        resolution: resolution(server, "desktop"),
      }),
    ).toThrow(TemplateConflict);
    expect(() =>
      planTemplateSync({ local: [], remote: [server], baseline: [template] }),
    ).toThrow(TemplateConflict);
    expect(
      planTemplateSync({
        local: [],
        remote: [deleted],
        baseline: [template],
      })[0].upload,
    ).toBe(false);
    expect(() =>
      planTemplateSync({ local: [local], remote: [], baseline: [template] }),
    ).toThrow("desktop copy has been kept");
  });
});
