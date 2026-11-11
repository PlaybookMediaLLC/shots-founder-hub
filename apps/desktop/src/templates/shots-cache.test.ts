import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { TransactionStatement } from "@anlg/db-runtime";

import {
  cachedTemplate,
  copyConflictedTemplateStatements,
  templateCacheKey,
  templateCacheOwnerStatement,
  templateCacheRowSchema,
  templateCacheStatements,
} from "./shots-cache";
import type { ShotsTemplate } from "./shots-reconcile";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

describe("Shots template offline cache", () => {
  it("keeps edits made during a pull, acknowledges uploaded edits, and retains a copy when resolving a deletion", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of [
        "20260413020000_templates",
        "20260712170000_template_icons",
      ]) {
        db.exec(
          readFileSync(
            require.resolve(
              `../../../../crates/db-app/migrations/${migration}.sql`,
            ),
            "utf8",
          ),
        );
      }
      db.exec(
        "CREATE TABLE app_settings(id TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
      );
      db.exec(
        "INSERT INTO templates(id,title,sections_json) VALUES('private-template','Initial','[]')",
      );
      const row = () =>
        templateCacheRowSchema.parse(
          db
            .prepare("SELECT * FROM templates WHERE id='private-template'")
            .get(),
        );
      const original = row();
      expect(
        cachedTemplate({
          ...original,
          sections_json: '["Updates",{"title":"Feedback"}]',
          targets_json: '"Manager"',
        }),
      ).toMatchObject({
        sections: [
          { title: "Updates", description: "" },
          { title: "Feedback", description: "" },
        ],
        targets: ["Manager"],
      });
      const remote: ShotsTemplate = {
        ...cachedTemplate(original),
        version: 1,
        seeded: false,
        deletedAt: null,
      };
      const accountId = "account-a";
      const key = templateCacheKey(accountId, remote.id);
      db.prepare("INSERT INTO app_settings VALUES(?,?)").run(
        key,
        JSON.stringify(remote),
      );
      const apply = (statements: TransactionStatement[]) => {
        db.exec("BEGIN");
        try {
          for (const statement of statements) {
            const result = db
              .prepare(statement.sql)
              .run(...(statement.params as SQLInputValue[]));
            if (
              statement.expectedRowsAffected !== undefined &&
              Number(result.changes) !== statement.expectedRowsAffected
            )
              throw new Error("Concurrent cache edit");
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      };
      const baseline = () =>
        JSON.parse(
          String(
            db
              .prepare("SELECT value_json FROM app_settings WHERE id=?")
              .get(key)?.value_json,
          ),
        );
      apply([templateCacheOwnerStatement(accountId)]);
      db.prepare("UPDATE templates SET title=? WHERE id=?").run(
        "Edited while fetching",
        remote.id,
      );
      expect(() =>
        apply(
          templateCacheStatements({
            expected: original,
            remote: { ...remote, title: "Server edit", version: 2 },
            accountId,
            uploaded: false,
          }),
        ),
      ).toThrow("Concurrent cache edit");
      expect(row().title).toBe("Edited while fetching");
      expect(baseline().version).toBe(1);
      apply(
        templateCacheStatements({
          expected: original,
          remote: { ...remote, title: "Earlier desktop upload", version: 2 },
          accountId,
          uploaded: true,
        }),
      );
      expect(row().title).toBe("Edited while fetching");
      expect(baseline().title).toBe("Earlier desktop upload");
      const deleted = {
        ...remote,
        version: 3,
        deletedAt: "2026-11-10T00:00:00Z",
      };
      apply(
        copyConflictedTemplateStatements(
          row(),
          deleted,
          accountId,
          "saved-copy",
        ),
      );
      expect(
        db.prepare("SELECT id FROM templates WHERE id=?").get(remote.id),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT title FROM templates WHERE id='saved-copy'").get()
          ?.title,
      ).toBe("Edited while fetching (Desktop copy)");
      expect(baseline().deletedAt).toBe(deleted.deletedAt);
      expect(() => apply([templateCacheOwnerStatement("account-b")])).toThrow();
      expect(() =>
        apply(
          templateCacheStatements({
            expected: undefined,
            remote: { ...remote, id: "other-account" },
            accountId: "account-b",
            uploaded: false,
          }),
        ),
      ).toThrow();
      expect(
        db.prepare("SELECT id FROM templates WHERE id='other-account'").get(),
      ).toBeUndefined();
      expect(
        db
          .prepare(
            "SELECT value_json FROM app_settings WHERE id='shots_templates_owner'",
          )
          .get()?.value_json,
      ).toBe(JSON.stringify(accountId));
      expect(() =>
        cachedTemplate({ ...original, sections_json: "not JSON" }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
