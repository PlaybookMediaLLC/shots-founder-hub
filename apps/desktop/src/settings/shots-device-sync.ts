import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { downloadDir, homeDir } from "@tauri-apps/api/path";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";
import { z } from "zod";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { commands as detect } from "@anlg/plugin-detect";
import { commands as opener } from "@anlg/plugin-opener2";
import { commands as permissions } from "@anlg/plugin-permissions";
import { commands as transcription } from "@anlg/plugin-transcription";

import {
  createPrivateActionIdentity,
  openAutoFormatRequest,
  openDictationStatusRequest,
} from "./shots-private-action";

import { useLanguageModel } from "~/ai/hooks";
import { useAuth } from "~/auth";
import { useBillingAccess } from "~/auth/billing-context";
import { getDeviceIdentity } from "~/auth/cloudsync-credentials";
import { env } from "~/env";
import { useDictationStatus } from "~/dictation/state";
import {
  authenticateDevice,
  DEVICE_AUTH_REASON,
  isDeviceAuthAvailable,
} from "~/lock/auth";
import { useAppLock } from "~/lock/store";
import { getStoredSettingValues, setSettingValue } from "~/settings/queries";
import { isAppStoreBuild } from "~/shared/app-store";
import {
  normalizeCompletionSoundName,
  previewCompletionSound,
} from "~/shared/completion-sound";
import { useTabs } from "~/store/zustand/tabs";
import { inferSummaryFormat } from "~/templates/auto-format-inference";

const permissionSchema = z.enum([
  "microphone",
  "systemAudio",
  "accessibility",
  "calendar",
  "screenRecording",
  "reminders",
  "contacts",
  "inputMonitoring",
]);
const commandSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  deviceId: z.string(),
  kind: z.enum([
    "choose-export-directory",
    "open-export-directory",
    "request-permission",
    "open-permission",
    "set-lock",
    "preview-sound",
    "show-release-notes",
    "auto-format",
    "dictation-status",
    "dictation-retry",
    "dictation-cancel",
    "show-dictation-shortcut",
  ]),
  argument: z.string().max(201000),
  status: z.literal("running"),
  expiresAt: z.iso.datetime(),
});

function unwrap<T>(
  result: { status: "ok"; data: T } | { status: "error"; error: string },
): T {
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}

export function useShotsDeviceSync(auth: ReturnType<typeof useAuth>) {
  const accountId = auth.session?.user.id;
  const client = useQueryClient();
  const enabled = Boolean(env.VITE_SHOTS_URL && accountId);
  const model = useLanguageModel("enhance");
  const billing = useBillingAccess();
  const privateIdentity = useQuery({
    queryKey: ["shots-private-action-key", accountId],
    enabled,
    queryFn: createPrivateActionIdentity,
    staleTime: Infinity,
    gcTime: 0,
  });
  const inventory = useQuery({
    queryKey: ["shots-native-inventory", accountId],
    enabled,
    staleTime: 300_000,
    refetchInterval: 300_000,
    refetchIntervalInBackground: true,
    queryFn: async () => {
      const [
        version,
        identifier,
        homeDirectory,
        downloadsDirectory,
        installed,
        ignored,
      ] = await Promise.all([
        getVersion(),
        getIdentifier(),
        homeDir(),
        downloadDir(),
        detect.listInstalledApplications(),
        detect.listDefaultIgnoredBundleIds(),
      ]);
      return {
        version,
        identifier,
        homeDirectory,
        downloadsDirectory,
        installedApps: unwrap(installed),
        defaultIgnoredApps: unwrap(ignored),
      };
    },
  });
  const sync = useQuery({
    queryKey: ["shots-device-sync", accountId],
    enabled:
      enabled && Boolean(inventory.data) && Boolean(privateIdentity.data),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: false,
    queryFn: async ({ signal }) => {
      const session = await auth.getSessionForRequest({
        requireLibraryAdmission: true,
      });
      if (!session || session.user.id !== accountId || !inventory.data)
        return null;
      const identity = await getDeviceIdentity();
      if (!identity.fingerprint)
        throw new Error("Cannot identify this computer.");
      const current = async () => {
        const currentSession = await auth.getSessionForRequest({
          requireLibraryAdmission: true,
        });
        return !signal.aborted && currentSession?.user.id === accountId;
      };
      const request = async (path: string, body: unknown, method = "POST") => {
        const response = await fetch(
          new URL(`/cloud/settings/devices/${path}`, env.VITE_API_URL),
          {
            method,
            signal,
            headers: {
              authorization: `Bearer ${session.access_token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
        if (!response.ok)
          throw new Error(
            `Shots device settings are unavailable (${response.status}).`,
          );
        return response.json();
      };
      const [microphones, lockAvailable, permissionStates] = await Promise.all([
        transcription.listMicrophoneDevices().then(unwrap),
        isDeviceAuthAvailable(),
        Promise.all(
          permissionSchema.options.map(async (permission) => {
            const result = await permissions.checkPermission(permission);
            return [
              permission,
              result.status === "ok" ? result.data : "unknown",
            ];
          }),
        ),
      ]);
      if (!(await current())) return null;
      const commands = z
        .array(commandSchema)
        .max(1)
        .parse(
          await request("report", {
            deviceId: identity.fingerprint,
            name: identity.name ?? "Computer",
            report: {
              ...inventory.data,
              platform: platform(),
              locale: navigator.language,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              appStore: isAppStoreBuild(),
              lockAvailable,
              microphones,
              permissions: Object.fromEntries(permissionStates),
              autoFormatKey: privateIdentity.data?.publicKey,
            },
          }),
        );
      for (const command of commands) {
        if (
          command.deviceId !== identity.fingerprint ||
          Date.parse(command.expiresAt) <= Date.now() ||
          !(await current())
        )
          continue;
        let error = "";
        let result = "";
        try {
          switch (command.kind) {
            case "dictation-status": {
              if (!privateIdentity.data) throw new Error("Private device connection is unavailable.");
              const request = await openDictationStatusRequest(privateIdentity.data.privateKey, command.argument);
              if (!(await current())) return null;
              const { phase, ready, error, lastTranscript } = useDictationStatus.getState();
              result = await request.sealResult({phase, ready, error, lastTranscript});
              break;
            }
            case "dictation-retry":
              useDictationStatus.setState(state => ({ retry: state.retry + 1 }));
              break;
            case "dictation-cancel":
              useDictationStatus.getState().cancel?.();
              break;
            case "show-dictation-shortcut":
              useTabs.getState().openNew({type: "settings", state: {tab: "dictation"}});
              await getCurrentWindow().show();
              await getCurrentWindow().setFocus();
              break;
            case "auto-format": {
              if (!privateIdentity.data || !model || !billing.isPro) {
                throw new Error(
                  "Summary formatting requires a selected model and Pro access.",
                );
              }
              const request = await openAutoFormatRequest(
                privateIdentity.data.privateKey,
                command.argument,
              );
              if (!(await current())) return null;
              const format = await inferSummaryFormat({
                model,
                examples: request.examples,
              });
              result = await request.sealResult(format);
              break;
            }
            case "show-release-notes":
              useTabs.getState().openNew({
                type: "changelog",
                state: {
                  current: inventory.data.version,
                  previous: inventory.data.version,
                },
              });
              break;
            case "choose-export-directory": {
              const selected = await chooseFolder({
                title: "Choose export folder",
                directory: true,
                multiple: false,
                defaultPath:
                  (await getStoredSettingValues()).values.export_directory ||
                  inventory.data.downloadsDirectory,
              });
              if (!selected)
                throw new Error("The folder selection was cancelled.");
              if (!(await current())) return null;
              await setSettingValue("export_directory", selected);
              break;
            }
            case "open-export-directory":
              unwrap(
                await opener.revealItemInDir(
                  (await getStoredSettingValues()).values.export_directory ||
                    inventory.data.downloadsDirectory,
                ),
              );
              break;
            case "request-permission":
              unwrap(
                await permissions.requestPermission(
                  permissionSchema.parse(command.argument),
                ),
              );
              break;
            case "open-permission":
              unwrap(
                await permissions.openPermission(
                  permissionSchema.parse(command.argument),
                ),
              );
              break;
            case "set-lock": {
              const value =
                z.enum(["true", "false"]).parse(command.argument) === "true";
              if (
                !(await authenticateDevice(
                  DEVICE_AUTH_REASON.changeLockSettings,
                ))
              )
                throw new Error("Device authentication was cancelled.");
              if (!(await current())) return null;
              await setSettingValue("lock_app", value);
              if (value) useAppLock.getState().lockApp();
              break;
            }
            case "preview-sound":
              previewCompletionSound(
                normalizeCompletionSoundName(command.argument),
              );
              break;
          }
        } catch {
          error =
            "The action did not complete on this computer. Check the desktop and try again.";
        }
        if (!(await current())) return null;
        await request(
          `commands/${command.id}`,
          {
            deviceId: identity.fingerprint,
            status: error ? "failed" : "succeeded",
            error,
            result,
          },
          "PATCH",
        );
        await client.invalidateQueries({
          queryKey: ["shots-settings-sync", accountId],
        });
      }
      return { synchronizedAt: Date.now() };
    },
  });
  return { error: inventory.error || privateIdentity.error || sync.error };
}
