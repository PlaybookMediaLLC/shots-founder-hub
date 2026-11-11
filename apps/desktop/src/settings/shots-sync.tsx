import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { z } from "zod";

import { Button } from "@anlg/ui/components/ui/button";

import { useAuth } from "~/auth";
import { getDeviceIdentity } from "~/auth/cloudsync-credentials";
import { liveQueryClient } from "~/db";
import { env } from "~/env";
import {
  applyShotsSettingsSnapshot,
  getStoredSettingValues,
} from "~/settings/queries";
import {
  SETTING_DEFINITIONS,
  SYNCED_SETTING_KEYS,
  type SettingKey,
  type SettingValues,
} from "~/settings/schema";
import { useShotsDeviceSync } from "~/settings/shots-device-sync";
import {
  reconcileSettings,
  SettingsConflict,
} from "~/settings/shots-reconcile";
import { TemplateConflict } from "~/templates/shots-reconcile";
import { useShotsTemplatesSync } from "~/templates/shots-sync";

const valuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
const profileSchema = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  version: z.number().int().nonnegative(),
  values: valuesSchema,
});
const settingsSchema = z.object({
  profiles: z.array(profileSchema),
  catalog: z.record(
    z.string(),
    z.object({
      type: z.enum(["boolean", "number", "string"]),
      scope: z.enum(["account", "device"]),
    }),
  ),
});

export function ShotsSettingsSync() {
  const auth = useAuth();
  const deviceSync = useShotsDeviceSync(auth);
  const templatesSync = useShotsTemplatesSync(auth);
  const accountId = auth.session?.user.id;
  const resolution = useRef<"desktop" | "shots" | undefined>(undefined);
  const query = useQuery({
    queryKey: ["shots-settings-sync", accountId],
    enabled: Boolean(env.VITE_SHOTS_URL && accountId),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: false,
    queryFn: async ({ signal }) => {
      const session = await auth.getSessionForRequest({
        requireLibraryAdmission: true,
      });
      if (!session || session.user.id !== accountId) return null;
      const device = await getDeviceIdentity();
      if (!device.fingerprint)
        throw new Error("Cannot identify this computer for Shots settings.");
      const cacheId = `shots_settings_cache:${accountId}:${device.fingerprint}`;
      const isCurrentAccount = async () => {
        const currentSession = await auth.getSessionForRequest({
          requireLibraryAdmission: true,
        });
        return !signal.aborted && currentSession?.user.id === accountId;
      };
      const request = async (body?: unknown) => {
        const response = await fetch(
          new URL("/cloud/settings", env.VITE_API_URL),
          {
            method: body ? "PATCH" : "GET",
            signal,
            headers: {
              authorization: `Bearer ${session.access_token}`,
              "content-type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
          },
        );
        if (!response.ok)
          throw new Error(
            `Shots settings could not be synchronized (${response.status}).`,
          );
        return response.json();
      };
      const remote = settingsSchema.parse(await request());
      for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
        if (
          remote.catalog[key]?.type !== definition.type ||
          remote.catalog[key].scope !==
            (SYNCED_SETTING_KEYS.has(key as SettingKey) ? "account" : "device")
        )
          throw new Error(
            `Shots does not support setting ${key}. Update the backend before syncing.`,
          );
      }
      const local = await getStoredSettingValues();
      const rows = await liveQueryClient.execute<{ value_json: string }>(
        "SELECT value_json FROM app_settings WHERE id = ?",
        [cacheId],
      );
      const owner = await liveQueryClient.execute<{ value_json: string }>(
        "SELECT value_json FROM app_settings WHERE id = 'shots_settings_owner'",
      );
      const changingAccount =
        owner[0] && JSON.parse(owner[0].value_json) !== accountId;
      const baseline = rows[0]
        ? valuesSchema.parse(JSON.parse(rows[0].value_json))
        : null;
      const managed = new Set(
        (
          await liveQueryClient.execute<{ id: string }>(
            "SELECT id FROM managed_app_settings",
          )
        ).map((row) => row.id),
      );
      const profiles = remote.profiles.filter(
        (profile) =>
          !profile.deviceId || profile.deviceId === device.fingerprint,
      );
      const values: SettingValues = Object.assign(
        {},
        ...profiles.map((profile) => profile.values),
      );
      const permittedLocal = changingAccount ? values : { ...local.values };
      for (const key of managed)
        Object.assign(permittedLocal, { [key]: values[key as SettingKey] });
      const { patch, next } = reconcileSettings({
        local: permittedLocal,
        baseline,
        remote: values,
        resolution: resolution.current,
      });
      for (const id of ["", device.fingerprint]) {
        const scoped = Object.fromEntries(
          Object.entries(patch).filter(
            ([key]) =>
              !managed.has(key) &&
              SYNCED_SETTING_KEYS.has(key as SettingKey) === (id === ""),
          ),
        );
        const profile = profiles.find((item) => item.deviceId === id);
        if (Object.keys(scoped).length || (!profile && id)) {
          if (!(await isCurrentAccount())) return null;
          const saved = profileSchema.parse(
            await request({
              deviceId: id,
              deviceName: id ? (device.name ?? "Computer") : "",
              baseVersion: profile?.version ?? 0,
              values: scoped,
            }),
          );
          Object.assign(next, saved.values);
        }
      }
      await applyShotsSettingsSnapshot(
        local.values,
        next,
        cacheId,
        accountId,
        isCurrentAccount,
      );
      resolution.current = undefined;
      return { synchronizedAt: Date.now() };
    },
  });
  if (!(query.error instanceof SettingsConflict)) {
    if (templatesSync.error instanceof TemplateConflict)
      return (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-t p-3 text-sm"
        >
          <span>
            {templatesSync.error.message} Keep desktop changes, or accept the
            Shots versions. Deleted templates are kept as desktop copies.
          </span>
          <Button size="sm" onClick={() => templatesSync.resolve("shots")}>
            Use Shots templates
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => templatesSync.resolve("desktop")}
          >
            Keep desktop changes
          </Button>
        </div>
      );
    const error = query.error || deviceSync.error || templatesSync.error;
    return error ? (
      <div role="alert" className="border-t p-3 text-sm">
        Shots settings have not synchronized. {error.message}
      </div>
    ) : null;
  }
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-t bg-white p-3 text-sm"
    >
      <span>
        Preferences changed in Shots and on this computer. Choose which changes
        to keep.
      </span>
      <Button
        size="sm"
        onClick={() => {
          resolution.current = "shots";
          void query.refetch();
        }}
      >
        Use Shots settings
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          resolution.current = "desktop";
          void query.refetch();
        }}
      >
        Keep desktop changes
      </Button>
    </div>
  );
}
