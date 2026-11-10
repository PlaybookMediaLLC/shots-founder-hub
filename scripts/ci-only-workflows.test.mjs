import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCiOnlyWorkflows,
  ciCondition,
  ciJobs,
} from "../.github/scripts/check_ci_only_workflows.mjs";

test("CI quarantine accepts supported self references and rejects execution escapes", () => {
  const workflows = Object.fromEntries(
    Object.entries(ciJobs).map(([file, jobs]) => [
      file,
      {
        on: { pull_request: { branches: ["develop"] } },
        permissions: { contents: "read" },
        jobs: Object.fromEntries(
          jobs.map((job) => [
            job,
            { if: ciCondition, "runs-on": "ubuntu-24.04", steps: [] },
          ]),
        ),
      },
    ]),
  );
  workflows["release.yaml"] = {
    on: { workflow_call: null },
    permissions: {},
    jobs: { deploy: { if: false, permissions: {} } },
  };
  const actions = {
    "./.github/actions/pnpm_install": {
      runs: {
        using: "composite",
        steps: [{ run: "pnpm install --frozen-lockfile" }],
      },
    },
  };
  workflows["ci.yaml"].jobs.ci.steps = [
    { uses: "$/.github/actions/pnpm_install" },
  ];
  workflows["desktop_ci.yaml"].jobs.js_ci.steps = [
    { uses: "./.github/actions/pnpm_install" },
  ];
  assert.doesNotThrow(() => checkCiOnlyWorkflows(workflows, actions));

  for (const change of [
    (w) => {
      w["release.yaml"].jobs.deploy.if = "always()";
    },
    (w) => {
      w["release.yaml"].on.schedule = [{ cron: "0 9 * * *" }];
    },
    (w) => {
      w["release.yaml"].on.workflow_dispatch = {};
    },
    (w) => {
      w["ci.yaml"].jobs.ci.if = "always()";
    },
    (w) => {
      w["ci.yaml"].jobs.ci.permissions = { contents: "write" };
    },
    (w) => {
      w["ci.yaml"].jobs.ci.env = { TOKEN: "${{ secrets.PROVIDER_TOKEN }}" };
    },
    (w) => {
      w["ci.yaml"].jobs.ci.env = { TOKEN: "${{ secrets['PROVIDER_TOKEN'] }}" };
    },
    (w) => {
      w["ci.yaml"].jobs.ci.uses = "./.github/workflows/release.yaml";
    },
    (w) => {
      w["ci.yaml"].jobs.ci.uses = "$/.github/workflows/release.yaml";
    },
    (w) => {
      w["ci.yaml"].jobs.ci.steps = [{ uses: "unreviewed/deployer@main" }];
    },
    (w) => {
      w["ci.yaml"].jobs.ci.steps = [
        { uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262" },
      ];
    },
  ]) {
    const unsafe = structuredClone(workflows);
    change(unsafe);
    assert.throws(() => checkCiOnlyWorkflows(unsafe, actions));
  }
});
