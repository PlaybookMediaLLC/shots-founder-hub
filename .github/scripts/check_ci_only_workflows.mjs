import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

export const ciJobs = {
  "ci.yaml": ["ci"],
  "fmt.yaml": ["fmt"],
  "lint.yaml": ["lint"],
  "desktop_ci.yaml": ["js_ci", "desktop_i18n"],
  "web_ci.yaml": ["ci"],
  "mobile_ci.yaml": ["mobile_checks"],
  "stripe_ci.yaml": ["ci"],
};

export const ciCondition =
  "${{ github.repository == 'PlaybookMediaLLC/shots-founder-hub' && github.event_name == 'pull_request' && github.base_ref == 'develop' && github.event.pull_request.head.repo.full_name == github.repository }}";

const ciActions = new Set([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "dtolnay/rust-toolchain@683b588c487a69d01f6c6ddf40f036ff682cc2c8",
  "denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed",
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  "./.github/actions/pnpm_install",
  "./.github/actions/bun_install",
  "$/.github/actions/pnpm_install",
  "$/.github/actions/bun_install",
]);

export function checkCiOnlyWorkflows(workflows, actions) {
  function checkSteps(steps, seen = new Set()) {
    for (const step of steps ?? []) {
      if (!step.uses) continue;
      assert(ciActions.has(step.uses), `Unreviewed CI action: ${step.uses}`);
      if (step.uses.startsWith("actions/checkout@")) {
        assert.equal(step.with?.["persist-credentials"], false);
      }
      if (step.uses.startsWith("./") || step.uses.startsWith("$/")) {
        const local = step.uses.startsWith("$/")
          ? `./${step.uses.slice(2)}`
          : step.uses;
        assert(!seen.has(local), "Recursive composite action");
        const action = actions[local];
        assert(action, `Missing CI action: ${step.uses}`);
        assert(
          !/\bsecrets\b/.test(JSON.stringify(action)),
          "CI helper accesses secrets",
        );
        checkSteps(action.runs?.steps, new Set([...seen, local]));
      }
    }
  }

  for (const [file, workflow] of Object.entries(workflows)) {
    const allowed = ciJobs[file] ?? [];
    assert.deepEqual(
      workflow.permissions,
      allowed.length ? { contents: "read" } : {},
      `${file}: token permissions`,
    );
    const events = Object.keys(workflow.on ?? {});
    assert(
      events.length > 0 &&
        events.every(
          (event) =>
            event === "workflow_call" ||
            (allowed.length && event === "pull_request"),
        ),
      `${file}: unreviewed event`,
    );
    if (allowed.length)
      assert.deepEqual(workflow.on.pull_request, { branches: ["develop"] });
    assert(Object.keys(workflow.jobs ?? {}).length, `${file}: no jobs`);
    for (const job of allowed)
      assert(workflow.jobs[job], `${file}: missing CI job ${job}`);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (!allowed.includes(id)) {
        assert.equal(job.if, false, `${file}/${id}: must remain disabled`);
        assert.deepEqual(
          job.permissions,
          {},
          `${file}/${id}: disabled token permissions`,
        );
        continue;
      }
      assert.equal(job.if, ciCondition, `${file}/${id}: CI event guard`);
      assert(
        !job.uses && !job.environment && !job.secrets,
        `${file}/${id}: privileged entrypoint`,
      );
      assert(
        !/\bsecrets\b/.test(JSON.stringify({ env: workflow.env, job })),
        `${file}/${id}: CI accesses secrets`,
      );
      if (job.permissions)
        assert.deepEqual(job.permissions, { contents: "read" });
      assert(["ubuntu-24.04", "ubuntu-latest"].includes(job["runs-on"]));
      checkSteps(job.steps);
    }
  }
  for (const file of Object.keys(ciJobs))
    assert(workflows[file], `Missing CI workflow: ${file}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const load = (file) => {
    const document = YAML.parseDocument(readFileSync(file, "utf8"), {
      uniqueKeys: true,
    });
    assert.equal(document.errors.length, 0, `${file}: invalid YAML`);
    return document.toJS();
  };
  const workflows = Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => [file, load(`.github/workflows/${file}`)]),
  );
  const actions = Object.fromEntries(
    ["pnpm_install", "bun_install"].map((name) => [
      `./.github/actions/${name}`,
      load(`.github/actions/${name}/action.yaml`),
    ]),
  );
  checkCiOnlyWorkflows(workflows, actions);
  console.log(
    `CI-only policy passes: ${Object.keys(workflows).length} workflows, ${Object.values(ciJobs).flat().length} allowed jobs; all other jobs disabled.`,
  );
}
