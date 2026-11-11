import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { z } from "zod";

import {
  cachedTemplate,
  copyConflictedTemplateStatements,
  templateCacheRowSchema,
  templateCacheOwnerStatement,
  templateCacheStatements,
} from "./shots-cache";
import {
  planTemplateSync,
  shotsTemplateContentSchema,
  shotsTemplateSchema,
  TemplateConflict,
  type TemplateResolution,
  type ShotsTemplate,
} from "./shots-reconcile";

import { useAuth } from "~/auth";
import { executeTransaction, liveQueryClient } from "~/db";
import { enqueueDatabaseWrite } from "~/db/write-queue";
import { env } from "~/env";
import { getStoredSettingValues, setSettingValue } from "~/settings/queries";

export function useShotsTemplatesSync(auth: ReturnType<typeof useAuth>) {
  const accountId = auth.session?.user.id;
  const resolution = useRef<TemplateResolution | undefined>(undefined);
  const query = useQuery({
    queryKey: ["shots-templates-sync", accountId],
    enabled: Boolean(env.VITE_SHOTS_URL && accountId),
    refetchInterval: 15000,
    refetchIntervalInBackground: true,
    retry: false,
    queryFn: async ({ signal }) => {
      const choice = resolution.current;
      resolution.current = undefined;
      const session = await auth.getSessionForRequest({
        requireLibraryAdmission: true,
      });
      if (!accountId || !session || session.user.id !== accountId) return null;
      const current = async () => {
        const currentSession = await auth.getSessionForRequest({
          requireLibraryAdmission: true,
        });
        return !signal.aborted && currentSession?.user.id === accountId;
      };
      const owner = await liveQueryClient.execute<{ value_json: string }>(
        "SELECT value_json FROM app_settings WHERE id='shots_templates_owner'",
      );
      if (owner[0] && JSON.parse(owner[0].value_json) !== accountId)
        throw new Error(
          "This template cache belongs to another Shots account. Connect that library before synchronizing it.",
        );
      if (!(await current())) return null;
      if (!owner[0]) {
        await enqueueDatabaseWrite("shots-templates", () =>
          executeTransaction([templateCacheOwnerStatement(accountId)]),
        );
      }
      const request = async (suffix: string, body?: unknown) => {
        if (!(await current()))
          throw new Error(
            "The Shots account changed during template synchronization.",
          );
        const response = await fetch(
          new URL(`/cloud/settings/templates${suffix}`, env.VITE_API_URL),
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
            `Shots templates could not synchronize (${response.status}). Desktop changes have been kept.`,
          );
        return response.json();
      };
      const remote: ShotsTemplate[] = [];
      const baselineRows = await liveQueryClient.execute<{
        value_json: string;
      }>("SELECT value_json FROM app_settings WHERE id GLOB ?", [
        `shots_template_cache:${accountId}:*`,
      ]);
      const baseline = baselineRows.map((row) =>
        shotsTemplateSchema.parse(JSON.parse(row.value_json)),
      );
      const revisionId = `shots_templates_revision:${accountId}`;
      const revisions = await liveQueryClient.execute<{ value_json: string }>(
        "SELECT value_json FROM app_settings WHERE id=?",
        [revisionId],
      );
      const revision = z
        .string()
        .regex(/^[0-9]{0,20}$/)
        .parse(revisions[0] ? JSON.parse(revisions[0].value_json) : "");
      let snapshotRevision = "";
      let cursor = "";
      do {
        const page = z
          .object({
            items: z.array(shotsTemplateSchema).max(50),
            nextCursor: z.string().regex(/^[a-zA-Z0-9_-]{0,160}$/),
            revision: z.string().regex(/^[0-9]{1,20}$/),
            unchanged: z.boolean(),
          })
          .parse(
            await request(
              `?${new URLSearchParams({ cursor, includeDeleted: "true", revision })}`,
            ),
          );
        if (page.nextCursor && page.nextCursor <= cursor)
          throw new Error("Shots returned an invalid template cursor.");
        if (!cursor) snapshotRevision = page.revision;
        if (page.unchanged) {
          if (
            cursor ||
            page.nextCursor ||
            !revision ||
            page.revision !== revision
          )
            throw new Error("Shots returned an invalid template revision.");
          remote.push(...baseline);
          break;
        }
        remote.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      const rows = z
        .array(templateCacheRowSchema)
        .parse(await liveQueryClient.execute("SELECT * FROM templates"));
      const actions = planTemplateSync({
        local: rows.map(cachedTemplate),
        remote,
        baseline,
        resolution: choice,
      });
      for (const action of actions) {
        const expected = rows.find((row) => row.id === action.id);
        if (action.copy && expected && action.remote) {
          const copyId = crypto.randomUUID();
          if (!(await current())) return null;
          await enqueueDatabaseWrite("shots-templates", () =>
            executeTransaction(
              copyConflictedTemplateStatements(
                expected,
                action.remote!,
                accountId,
                copyId,
              ),
            ),
          );
          const settings = await getStoredSettingValues();
          if (
            settings.values.selected_template_id === action.id &&
            (await current())
          )
            await setSettingValue("selected_template_id", copyId);
          continue;
        }
        let next = action.remote;
        if (action.upload) {
          next = shotsTemplateSchema.parse(
            await request(
              `/${action.id}`,
              action.local
                ? {
                    baseVersion: action.remote?.version ?? 0,
                    content: shotsTemplateContentSchema.parse(action.local),
                    pinned: action.local.pinned,
                    ...(!action.remote || action.remote.seeded
                      ? { importedUpdatedAt: action.local.updatedAt }
                      : {}),
                  }
                : { baseVersion: action.remote?.version ?? 0, deleted: true },
            ),
          );
        }
        if (!next || !(await current())) continue;
        await enqueueDatabaseWrite("shots-templates", () =>
          executeTransaction(
            templateCacheStatements({
              expected,
              remote: next!,
              accountId,
              uploaded: action.upload,
            }),
          ),
        );
      }
      if (!(await current())) return null;
      if (snapshotRevision !== revision)
        await enqueueDatabaseWrite("shots-templates", () =>
          executeTransaction([
            templateCacheOwnerStatement(accountId),
            {
              sql: "INSERT INTO app_settings(id,value_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json",
              params: [revisionId, JSON.stringify(snapshotRevision)],
            },
          ]),
        );
      resolution.current = undefined;
      return { synchronizedAt: Date.now() };
    },
  });
  return {
    error: query.error,
    resolve: (choice: "shots" | "desktop") => {
      if (!(query.error instanceof TemplateConflict)) return;
      resolution.current = { choice, snapshots: query.error.snapshots };
      void query.refetch();
    },
  };
}
