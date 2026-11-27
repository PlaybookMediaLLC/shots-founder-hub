import json
import unittest

from prepare_api_service_secrets import CORE, SHARED, SHOTS, SYNC
from render_cloud_run_spec import (
    MIGRATE_JOB_NAME,
    PORT,
    SERVICE_NAME,
    render_manifests,
    secret_id,
)


class CloudRunSpecTests(unittest.TestCase):
    def setUp(self):
        keys = SHARED | SHOTS | SYNC | CORE | {"FOUNDER_HUB_MCP_URL"}
        keys |= {
            "OPENROUTER_API_KEY",
            "API_BASE_URL",
            "CALLBACK_SECRET",
            "DEEPGRAM_API_KEY",
        }
        self.secrets = [{"key": key, "value": f"secret-value-{key}"} for key in keys]
        # Deploy-only credentials must never reach Cloud Run or Secret Manager.
        self.secrets.append(
            {"key": "DIGITALOCEAN_ACCESS_TOKEN", "value": "do-deploy-only"}
        )
        self.secrets.append(
            {"key": "DATABASE_MIGRATION_URL", "value": "postgres://migrator-only"}
        )
        self.image = "us-west1-docker.pkg.dev/shots-founder-hub-prod/shots-founder-hub/founder-hub-api:abc123"
        self.migrate, self.service, self.plan = render_manifests(
            image=self.image,
            secrets=self.secrets,
            region="us-west1",
            service_account="sa-api-runtime@shots-founder-hub-prod.iam.gserviceaccount.com",
        )

    def service_container(self):
        return self.service["spec"]["template"]["spec"]["containers"][0]

    def service_envs(self):
        return {entry["name"]: entry for entry in self.service_container()["env"]}

    def test_service_uses_combined_role_secret_refs_and_never_embeds_raw_secrets(self):
        serialized = json.dumps(self.service)
        self.assertNotIn("secret-value-", serialized)
        self.assertNotIn("migrator-only", serialized)
        self.assertNotIn("do-deploy-only", serialized)

        envs = self.service_envs()
        self.assertEqual(envs["ANARLOG_SERVICE"]["value"], "all")
        self.assertEqual(envs["ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED"]["value"], "true")
        self.assertEqual(envs["DATABASE_MAX_CONNECTIONS"]["value"], "8")
        # Cloud Run reserves PORT and injects it from containerPort.
        self.assertNotIn("PORT", envs)
        self.assertNotIn("DATABASE_MIGRATION_URL", envs)
        self.assertNotIn("DATABASE_POOL_URL", envs)
        self.assertNotIn("DIGITALOCEAN_ACCESS_TOKEN", envs)

        self.assertEqual(
            envs["DATABASE_URL"]["valueFrom"]["secretKeyRef"],
            {"name": secret_id("DATABASE_URL"), "key": "latest"},
        )
        self.assertEqual(
            envs["NANGO_API_KEY"]["valueFrom"]["secretKeyRef"],
            {"name": secret_id("NANGO_API_KEY"), "key": "latest"},
        )
        self.assertEqual(
            envs["GOOGLE_DRIVE_PICKER_REDIRECT_URI"]["valueFrom"]["secretKeyRef"],
            {"name": secret_id("GOOGLE_DRIVE_PICKER_REDIRECT_URI"), "key": "latest"},
        )

    def test_service_configures_http1_websockets_probes_and_always_on_cpu(self):
        self.assertEqual(self.service["metadata"]["name"], SERVICE_NAME)
        container = self.service_container()
        self.assertEqual(container["image"], self.image)
        self.assertEqual(container["ports"], [{"name": "http1", "containerPort": PORT}])
        self.assertEqual(
            container["startupProbe"]["httpGet"], {"path": "/health", "port": PORT}
        )
        self.assertEqual(
            container["livenessProbe"]["httpGet"], {"path": "/health", "port": PORT}
        )

        template = self.service["spec"]["template"]
        annotations = template["metadata"]["annotations"]
        self.assertEqual(annotations["autoscaling.knative.dev/minScale"], "1")
        self.assertEqual(annotations["autoscaling.knative.dev/maxScale"], "5")
        self.assertEqual(annotations["run.googleapis.com/cpu-throttling"], "false")
        self.assertEqual(annotations["run.googleapis.com/sessionAffinity"], "true")
        self.assertEqual(template["spec"]["timeoutSeconds"], 3600)

    def test_database_pool_url_overrides_runtime_database_url_only(self):
        with_pool = self.secrets + [
            {
                "key": "DATABASE_POOL_URL",
                "value": "postgres://pooler-only:6432/founder_hub?sslmode=require",
            }
        ]
        migrate, service, plan = render_manifests(
            image=self.image,
            secrets=with_pool,
            region="us-west1",
        )
        self.assertEqual(
            plan[secret_id("DATABASE_URL")],
            "postgres://pooler-only:6432/founder_hub?sslmode=require",
        )
        self.assertEqual(
            plan[secret_id("DATABASE_MIGRATION_URL")],
            "postgres://migrator-only",
        )
        self.assertNotIn("pooler-only", json.dumps(service))
        self.assertNotIn("pooler-only", json.dumps(migrate))

    def test_migration_job_uses_migration_url_secret_only(self):
        serialized = json.dumps(self.migrate)
        self.assertNotIn("migrator-only", serialized)
        self.assertNotIn("do-deploy-only", serialized)

        self.assertEqual(self.migrate["metadata"]["name"], MIGRATE_JOB_NAME)
        container = self.migrate["spec"]["template"]["spec"]["template"]["spec"][
            "containers"
        ][0]
        self.assertEqual(container["image"], self.image)
        self.assertEqual(container["command"], ["/usr/local/bin/migrate"])
        self.assertEqual(
            container["env"],
            [
                {
                    "name": "DATABASE_URL",
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": secret_id("DATABASE_MIGRATION_URL"),
                            "key": "latest",
                        }
                    },
                }
            ],
        )

    def test_secret_plan_excludes_unrelated_deploy_tokens_and_pins_versions(self):
        self.assertNotIn(secret_id("DIGITALOCEAN_ACCESS_TOKEN"), self.plan)
        self.assertIn(secret_id("DATABASE_MIGRATION_URL"), self.plan)
        self.assertIn(secret_id("DATABASE_URL"), self.plan)

        pinned = {name: "7" for name in self.plan}
        migrate, service, _ = render_manifests(
            image=self.image,
            secrets=self.secrets,
            secret_versions=pinned,
        )
        migrate_env = migrate["spec"]["template"]["spec"]["template"]["spec"][
            "containers"
        ][0]["env"][0]
        self.assertEqual(migrate_env["valueFrom"]["secretKeyRef"]["key"], "7")
        service_envs = {
            e["name"]: e
            for e in service["spec"]["template"]["spec"]["containers"][0]["env"]
        }
        self.assertEqual(
            service_envs["DATABASE_URL"]["valueFrom"]["secretKeyRef"]["key"], "7"
        )

    def test_missing_migration_url_or_transcription_provider_fails_render(self):
        without_migration = [
            s for s in self.secrets if s["key"] != "DATABASE_MIGRATION_URL"
        ]
        with self.assertRaisesRegex(ValueError, "DATABASE_MIGRATION_URL"):
            render_manifests(image=self.image, secrets=without_migration)

        without_stt = [s for s in self.secrets if s["key"] != "DEEPGRAM_API_KEY"]
        with self.assertRaisesRegex(ValueError, "transcription provider"):
            render_manifests(image=self.image, secrets=without_stt)


if __name__ == "__main__":
    unittest.main()
