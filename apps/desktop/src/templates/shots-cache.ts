import { z } from "zod";

import type { TransactionStatement } from "@anlg/db-runtime";

import {
  parseStoredTemplateSections,
  parseStoredTemplateTargets,
} from "./codec";
import {
  shotsTemplateContentSchema,
  type CachedTemplate,
  type ShotsTemplate,
} from "./shots-reconcile";
import { DEFAULT_TEMPLATE_ICON } from "./template-icon";

export const templateCacheRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  pinned: z.number().int().min(0).max(1),
  pin_order: z.number().nullable(),
  category: z.string().nullable(),
  icon_json: z.string().nullable(),
  targets_json: z.string().nullable(),
  sections_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type TemplateCacheRow = z.infer<typeof templateCacheRowSchema>;
const columns = Object.keys(templateCacheRowSchema.shape);
const matches = columns.map((column) => `${column} IS ?`).join(" AND ");
const values = (row: TemplateCacheRow) =>
  columns.map((column) => row[column as keyof TemplateCacheRow]);
export const templateCacheKey = (accountId: string, id: string) =>
  `shots_template_cache:${accountId}:${id}`;

export function templateCacheOwnerStatement(
  accountId: string,
): TransactionStatement {
  return {
    sql: "INSERT INTO app_settings(id,value_json) VALUES('shots_templates_owner',?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json WHERE value_json=excluded.value_json",
    params: [JSON.stringify(accountId)],
    expectedRowsAffected: 1,
  };
}

export function cachedTemplate(row: TemplateCacheRow): CachedTemplate {
  const content = shotsTemplateContentSchema.parse({
    title: row.title,
    description: row.description,
    category: row.category ?? "",
    icon: row.icon_json ? JSON.parse(row.icon_json) : DEFAULT_TEMPLATE_ICON,
    targets: parseStoredTemplateTargets(row.targets_json, row.id, true) ?? [],
    sections: parseStoredTemplateSections(row.sections_json, row.id, true),
  });
  return {
    ...content,
    id: row.id,
    pinned: row.pinned === 1,
    pinOrder: row.pin_order,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** An inbound snapshot and its baseline commit together, or a concurrent desktop edit wins. */
export function templateCacheStatements({
  expected,
  remote,
  accountId,
  uploaded,
}: {
  expected: TemplateCacheRow | undefined;
  remote: ShotsTemplate;
  accountId: string;
  uploaded: boolean;
}): TransactionStatement[] {
  const statements: TransactionStatement[] = [
    templateCacheOwnerStatement(accountId),
  ];
  const next: TemplateCacheRow = {
    id: remote.id,
    title: remote.title,
    description: remote.description,
    pinned: remote.pinned ? 1 : 0,
    pin_order: remote.pinOrder,
    category: remote.category,
    icon_json: JSON.stringify(remote.icon),
    targets_json: JSON.stringify(remote.targets),
    sections_json: JSON.stringify(remote.sections),
    created_at: expected?.created_at ?? remote.createdAt,
    updated_at: remote.updatedAt,
  };
  if (remote.deletedAt && expected) {
    statements.push({
      sql: `DELETE FROM templates WHERE ${matches}`,
      params: values(expected),
      ...(!uploaded ? { expectedRowsAffected: 1 } : {}),
    });
  } else if (!remote.deletedAt) {
    statements.push(
      expected
        ? {
            sql: `UPDATE templates SET ${columns.map((column) => `${column}=?`).join(",")} WHERE ${matches}`,
            params: [...values(next), ...values(expected)],
            ...(!uploaded ? { expectedRowsAffected: 1 } : {}),
          }
        : {
            sql: `INSERT INTO templates(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")}) ON CONFLICT(id) DO NOTHING`,
            params: values(next),
            ...(!uploaded ? { expectedRowsAffected: 1 } : {}),
          },
    );
  }
  statements.push({
    sql: `INSERT INTO app_settings(id,value_json) SELECT ?,? ${!uploaded && remote.deletedAt && !expected ? "WHERE NOT EXISTS(SELECT 1 FROM templates WHERE id=?)" : ""} ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json`,
    params: [
      templateCacheKey(accountId, remote.id),
      JSON.stringify(remote),
      ...(!uploaded && remote.deletedAt && !expected ? [remote.id] : []),
    ],
    expectedRowsAffected: 1,
  });
  return statements;
}

export function copyConflictedTemplateStatements(
  row: TemplateCacheRow,
  remote: ShotsTemplate,
  accountId: string,
  copyId: string,
): TransactionStatement[] {
  const copy = {
    ...row,
    id: copyId,
    title: row.title
      ? `${row.title} (Desktop copy)`
      : "Untitled (Desktop copy)",
  };
  return [
    {
      sql: `INSERT INTO templates(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      params: values(copy),
      expectedRowsAffected: 1,
    },
    ...templateCacheStatements({
      expected: row,
      remote,
      accountId,
      uploaded: false,
    }),
  ];
}
