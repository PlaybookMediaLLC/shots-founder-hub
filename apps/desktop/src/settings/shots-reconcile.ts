import {
  SETTING_DEFINITIONS,
  type SettingKey,
  type SettingValues,
} from "./schema";

export class SettingsConflict extends Error {
  constructor(public readonly keys: string[]) {
    super(`Settings changed in Shots and on this computer: ${keys.join(", ")}`);
  }
}

export function reconcileSettings({
  local,
  baseline,
  remote,
  resolution,
}: {
  local: SettingValues;
  baseline: SettingValues | null;
  remote: SettingValues;
  resolution?: "desktop" | "shots";
}) {
  const patch: Record<string, string | number | boolean | null> = {};
  const next: SettingValues = { ...remote };
  const conflicts: string[] = [];
  for (const key of Object.keys(SETTING_DEFINITIONS) as SettingKey[]) {
    const definition = SETTING_DEFINITIONS[key];
    const fallback = "default" in definition ? definition.default : undefined;
    const localValue = local[key] ?? fallback;
    const remoteValue = remote[key] ?? fallback;
    const previous = baseline?.[key] ?? fallback;
    const changed =
      baseline === null
        ? local[key] !== undefined && remote[key] === undefined
        : localValue !== previous;
    if (!changed || resolution === "shots") continue;
    if (
      baseline !== null &&
      remoteValue !== previous &&
      remoteValue !== localValue &&
      !resolution
    ) {
      conflicts.push(key);
      continue;
    }
    if (localValue !== remoteValue) {
      patch[key] = local[key] ?? null;
      Object.assign(next, { [key]: local[key] });
    }
  }
  if (conflicts.length) throw new SettingsConflict(conflicts);
  return { patch, next };
}
