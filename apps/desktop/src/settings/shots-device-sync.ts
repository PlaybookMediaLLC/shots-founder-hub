import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { downloadDir, homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";
import { z } from "zod";

import {
  createE2eeIdentity,
  execute,
  getCloudsyncStatus,
  getE2eeIdentityStatus,
  importE2eeIdentity,
  inspectE2eeRecoveryKey,
  syncCloudsyncNow,
} from "@anlg/plugin-db";
import { commands as detect } from "@anlg/plugin-detect";
import { commands as opener } from "@anlg/plugin-opener2";
import { commands as permissions } from "@anlg/plugin-permissions";
import { commands as tracing } from "@anlg/plugin-tracing";
import { commands as transcription } from "@anlg/plugin-transcription";

import {
  createPrivateActionIdentity,
  openAutoFormatRequest,
  openAIProviderRequest,
  openCloudsyncLogRequest,
  openCloudsyncRecoveryRequest,
  openDictationStatusRequest,
} from "./shots-private-action";

import { useLanguageModel } from "~/ai/hooks";
import { useAuth } from "~/auth";
import { useBillingAccess } from "~/auth/billing-context";
import { getDeviceIdentity } from "~/auth/cloudsync-credentials";
import { useDictationStatus } from "~/dictation/state";
import { env } from "~/env";
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
    "cloudsync-status",
    "cloudsync-now",
    "cloudsync-log",
    "cloudsync-recovery",
    "ai-provider",
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

async function claimE2eeIdentity(
  accessToken: string,
  keyId: string,
  signal: AbortSignal,
) {
  const response = await fetch(
    new URL("/sync/e2ee/identity", env.VITE_API_URL),
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ keyId }),
      signal,
    },
  );
  if (response.status === 409)
    throw new Error(
      "This account already uses another recovery key. Use the key from your first device.",
    );
  if (!response.ok)
    throw new Error("Could not protect this account. Try again.");
  const identity = (await response.json()) as { keyId?: unknown };
  if (identity.keyId !== keyId)
    throw new Error("The server returned an invalid key identity.");
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
              supportsCloudsyncSettings: true,
              supportsAIProviderSettings: true,
              supportsCloudsyncRecovery: true,
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
            case "cloudsync-status": {
              const [status, conflicts, parked] = await Promise.all([
                getCloudsyncStatus(),
                execute<{ note_count: number }>(`
                  SELECT COUNT(DISTINCT row_id) AS note_count
                  FROM e2ee_field_conflicts
                  WHERE resolved_at IS NULL
                    AND ((table_name = 'session_documents' AND field_name = 'body')
                      OR (table_name = 'sessions' AND field_name = 'title'))
                `),
                execute<{ reason: string; record_count: number }>(`
                  SELECT reason, COUNT(*) AS record_count
                  FROM e2ee_parked_records
                  GROUP BY reason
                `),
              ]);
              const parkedCounts = parked.reduce(
                (counts, row) => {
                  if (row.reason === "too_large")
                    counts.tooLarge += row.record_count;
                  if (
                    row.reason === "unknown_table" ||
                    row.reason === "unknown_field"
                  ) {
                    counts.pendingUpdate += row.record_count;
                  }
                  return counts;
                },
                { pendingUpdate: 0, tooLarge: 0 },
              );
              result = JSON.stringify({
                cloudsync_enabled: status.cloudsync_enabled,
                configured: status.configured,
                running: status.running,
                activity_paused: status.activity_paused,
                deferred_for_capture: status.deferred_for_capture,
                last_sync_at_ms: status.last_sync_at_ms,
                has_unsent_changes: status.has_unsent_changes,
                last_error_kind: status.last_error_kind,
                consecutive_failures: status.consecutive_failures,
                recovery_pending: status.recovery_pending ?? false,
                recovery_delayed: status.recovery_delayed ?? false,
                conflicted_notes: conflicts[0]?.note_count ?? 0,
                pending_update_records: parkedCounts.pendingUpdate,
                too_large_records: parkedCounts.tooLarge,
              });
              break;
            }
            case "cloudsync-now":
              await syncCloudsyncNow();
              break;
            case "cloudsync-log": {
              if (!privateIdentity.data)
                throw new Error("Private device connection is unavailable.");
              const request = await openCloudsyncLogRequest(
                privateIdentity.data.privateKey,
                command.argument,
              );
              if (!(await current())) return null;
              const log = await tracing.logContent(true);
              if (log.status === "error") throw new Error(log.error);
              result = await request.sealResult(
                truncatePrivateLog(log.data ?? ""),
              );
              break;
            }
            case "cloudsync-recovery": {
              if (!privateIdentity.data)
                throw new Error("Private device connection is unavailable.");
              const requestValue = await openCloudsyncRecoveryRequest(
                privateIdentity.data.privateKey,
                command.argument,
              );
              if (!(await current())) return null;
              const session = await auth.getSessionForRequest({
                requireLibraryAdmission: true,
              });
              if (!session || session.user.id !== accountId)
                throw new Error(
                  "Sign in again before changing the sync recovery key.",
                );
              let recoveryKey: string | undefined;
              if (requestValue.value.operation === "status") {
                const status = await getE2eeIdentityStatus(accountId!);
                result = await requestValue.sealResult({
                  configured: status.configured,
                });
                break;
              }
              if (requestValue.value.operation === "create") {
                recoveryKey = await createE2eeIdentity(accountId!);
                if (!(await current())) return null;
                result = await requestValue.sealResult({
                  configured: false,
                  recoveryKey,
                });
                break;
              }
              recoveryKey =
                requestValue.value.operation === "import"
                  ? requestValue.value.recoveryKey
                  : await createE2eeIdentity(accountId!);
              const identity = await inspectE2eeRecoveryKey(recoveryKey);
              if (!(await current())) return null;
              await claimE2eeIdentity(
                session.access_token,
                identity.keyId,
                signal,
              );
              if (!(await current())) return null;
              await importE2eeIdentity(accountId!, recoveryKey);
              result = await requestValue.sealResult({ configured: true });
              break;
            }
            case "ai-provider": {
              if (!privateIdentity.data)
                throw new Error("Private device connection is unavailable.");
              const request = await openAIProviderRequest(
                privateIdentity.data.privateKey,
                command.argument,
              );
              if (!(await current())) return null;
              const { operation, type, providerId } = request.value;
              if (operation === "save") {
                const { setAiProvider } = await import("~/settings/providers");
                await setAiProvider(type, providerId, {
                  base_url: request.value.baseUrl,
                  api_key: request.value.apiKey,
                });
              } else if (operation === "clear") {
                const { clearAiProvider } =
                  await import("~/settings/providers");
                await clearAiProvider(type, providerId);
              }
              const { getStoredAiProvider } =
                await import("~/settings/providers");
              const stored = await getStoredAiProvider(type, providerId);
              result = await request.sealResult({
                configured: Boolean(stored?.api_key),
                baseUrl: stored?.base_url ?? "",
              });
              break;
            }
            case "dictation-status": {
              if (!privateIdentity.data)
                throw new Error("Private device connection is unavailable.");
              const request = await openDictationStatusRequest(
                privateIdentity.data.privateKey,
                command.argument,
              );
              if (!(await current())) return null;
              const { phase, ready, error, lastTranscript } =
                useDictationStatus.getState();
              result = await request.sealResult({
                phase,
                ready,
                error,
                lastTranscript,
              });
              break;
            }
            case "dictation-retry":
              useDictationStatus.setState((state) => ({
                retry: state.retry + 1,
              }));
              break;
            case "dictation-cancel":
              useDictationStatus.getState().cancel?.();
              break;
            case "show-dictation-shortcut":
              useTabs
                .getState()
                .openNew({ type: "settings", state: { tab: "dictation" } });
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

function truncatePrivateLog(value: string) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(value);
  let start = 0;
  let end = bytes.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const tail = decoder.decode(bytes.subarray(middle));
    if (encoder.encode(JSON.stringify(tail)).length <= 100_000) end = middle;
    else start = middle + 1;
  }
  return decoder.decode(bytes.subarray(start));
}
