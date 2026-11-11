import { z } from "zod";

export const shotsTemplateContentSchema = z.object({
  title: z.string(),
  description: z.string(),
  category: z.string(),
  icon: z.discriminatedUnion("type", [
    z.object({ type: z.literal("icon"), value: z.string(), color: z.string() }),
    z.object({ type: z.literal("emoji"), value: z.string() }),
  ]),
  targets: z.array(z.string()),
  sections: z.array(z.object({ title: z.string(), description: z.string() })),
});
export const shotsTemplateSchema = shotsTemplateContentSchema.extend({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  version: z.number().int().positive(),
  pinned: z.boolean(),
  pinOrder: z.number().int().nonnegative().nullable(),
  seeded: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type ShotsTemplate = z.infer<typeof shotsTemplateSchema>;
export type CachedTemplate = Omit<
  ShotsTemplate,
  "version" | "seeded" | "deletedAt"
>;

export class TemplateConflict extends Error {
  constructor(
    public readonly titles: string[],
    public readonly snapshots: Record<string, string>,
  ) {
    super(
      `Templates changed in Shots and on this computer: ${titles.join(", ")}`,
    );
  }
}

export type TemplateResolution = {
  choice: "shots" | "desktop";
  snapshots: Record<string, string>;
};

function content(value: CachedTemplate | ShotsTemplate | undefined) {
  if (!value || ("deletedAt" in value && value.deletedAt)) return null;
  return JSON.stringify({
    ...shotsTemplateContentSchema.parse(value),
    pinned: value.pinned,
  });
}

/** Compare against the last acknowledged server value; never resolve concurrent edits by timestamp. */
export function planTemplateSync({
  local,
  remote,
  baseline,
  resolution,
}: {
  local: CachedTemplate[];
  remote: ShotsTemplate[];
  baseline: ShotsTemplate[];
  resolution?: TemplateResolution;
}) {
  const localById = new Map(local.map((item) => [item.id, item]));
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const baselineById = new Map(baseline.map((item) => [item.id, item]));
  const conflicts: string[] = [];
  const snapshots: Record<string, string> = {};
  const actions = [
    ...new Set([
      ...localById.keys(),
      ...remoteById.keys(),
      ...baselineById.keys(),
    ]),
  ].map((id) => {
    const here = localById.get(id),
      there = remoteById.get(id),
      before = baselineById.get(id);
    if (before && !there)
      throw new Error(
        "Shots did not return a previously synchronized template. The desktop copy has been kept.",
      );
    const same = content(here) === content(there);
    if (
      same &&
      before &&
      there?.version === before.version &&
      (there.deletedAt ||
        (here?.pinOrder === there.pinOrder &&
          here &&
          Date.parse(here.updatedAt) === Date.parse(there.updatedAt)))
    )
      return null;
    let upload = false,
      conflict = false;
    if (before) {
      const changedHere = content(here) !== content(before);
      const changedThere = content(there) !== content(before);
      conflict = !same && changedHere && changedThere;
      upload = !same && changedHere;
    } else if (there?.seeded) {
      upload = true;
    } else if (!there) {
      upload = Boolean(here);
    } else if (!same && here) {
      const untouchedDefault =
        here.id.startsWith("default-") &&
        !here.pinned &&
        here.createdAt === here.updatedAt;
      conflict = !untouchedDefault;
    }
    if (conflict) {
      const snapshot = JSON.stringify([content(here), there?.version]);
      if (resolution?.snapshots[id] !== snapshot) {
        conflicts.push(here?.title || there?.title || id);
        snapshots[id] = snapshot;
      }
      upload = resolution?.choice === "desktop";
    }
    return {
      id,
      local: here,
      remote: there,
      upload,
      copy: upload && Boolean(here && there?.deletedAt),
    };
  });
  if (conflicts.length) throw new TemplateConflict(conflicts, snapshots);
  return actions
    .filter((action) => action !== null)
    .sort(
      (a, b) =>
        (a.local?.pinOrder ?? Infinity) - (b.local?.pinOrder ?? Infinity),
    );
}
