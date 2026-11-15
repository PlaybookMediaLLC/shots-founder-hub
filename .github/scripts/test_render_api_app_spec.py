import unittest

from prepare_api_service_secrets import AI, SHARED, SHOTS, SYNC
from render_api_app_spec import render


class AppSpecTests(unittest.TestCase):
    def setUp(self):
        keys = SHARED | SHOTS | SYNC | {"FOUNDER_HUB_MCP_URL"}
        keys |= {
            "OPENROUTER_API_KEY",
            "API_BASE_URL",
            "CALLBACK_SECRET",
            "DEEPGRAM_API_KEY",
        }
        self.secrets = [{"key": key, "value": f"value-{key}"} for key in keys]
        # A deploy credential in the same export must never reach a service.
        self.secrets.append(
            {"key": "DIGITALOCEAN_ACCESS_TOKEN", "value": "deploy-only"}
        )
        self.secrets.append({"key": "DATABASE_MIGRATION_URL", "value": "migrator-url"})
        self.spec = render("abc123", self.secrets)
        self.services = {s["name"]: s for s in self.spec["services"]}

    def envs(self, name):
        return {e["key"]: e for e in self.services[name]["envs"]}

    def test_only_the_gateway_is_public_and_it_forwards_to_each_role(self):
        self.assertEqual(
            self.spec["ingress"]["rules"],
            [{"match": {"path": {"prefix": "/"}}, "component": {"name": "gateway"}}],
        )
        self.assertEqual(self.services["gateway"]["http_port"], 3001)
        gateway = self.envs("gateway")
        self.assertEqual(gateway["ANARLOG_SERVICE"]["value"], "all")
        for role in ["ai", "sync", "core"]:
            with self.subTest(role=role):
                self.assertNotIn("http_port", self.services[role])
                self.assertEqual(self.services[role]["internal_ports"], [3001])
                self.assertEqual(self.envs(role)["ANARLOG_SERVICE"]["value"], role)
                self.assertEqual(
                    gateway[f"ANARLOG_{role.upper()}_ORIGIN"]["value"],
                    f"http://{role}:3001",
                )
                # Role services reject upstream origins and would not start.
                self.assertFalse(
                    any(key.endswith("_ORIGIN") for key in self.envs(role))
                )

    def test_each_service_gets_only_its_role_secrets_as_encrypted_values(self):
        self.assertNotIn("DEEPGRAM_API_KEY", self.envs("sync"))
        self.assertNotIn("RESEND_API_KEY", self.envs("ai"))
        self.assertIn("DEEPGRAM_API_KEY", self.envs("gateway"))
        for name in self.services:
            envs = self.envs(name)
            with self.subTest(service=name):
                self.assertNotIn("DIGITALOCEAN_ACCESS_TOKEN", envs)
                self.assertEqual(envs["DATABASE_URL"]["type"], "SECRET")
                self.assertEqual(self.services[name]["image"]["tag"], "abc123")

    def test_only_core_runs_backup_cleanup(self):
        for name in self.services:
            with self.subTest(service=name):
                self.assertEqual(
                    self.envs(name)["ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED"]["value"],
                    "true" if name == "core" else "false",
                )

    def test_migrations_run_before_deploy_with_the_migration_role_only(self):
        (job,) = self.spec["jobs"]
        self.assertEqual(job["kind"], "PRE_DEPLOY")
        self.assertEqual(job["run_command"], "/usr/local/bin/migrate")
        self.assertEqual(
            [(e["key"], e["value"], e["type"]) for e in job["envs"]],
            [("DATABASE_URL", "migrator-url", "SECRET")],
        )
        for name in self.services:
            with self.subTest(service=name):
                self.assertNotIn("DATABASE_MIGRATION_URL", self.envs(name))
                self.assertNotEqual(
                    self.envs(name)["DATABASE_URL"]["value"], "migrator-url"
                )

    def test_shutdown_waits_longer_than_the_stream_drain(self):
        for name in self.services:
            with self.subTest(service=name):
                grace = self.services[name]["termination"]["grace_period_seconds"]
                self.assertGreater(grace, 270)
                self.assertLessEqual(grace, 600)

    def test_missing_transcription_provider_stops_the_render(self):
        secrets = [s for s in self.secrets if s["key"] != "DEEPGRAM_API_KEY"]
        with self.assertRaisesRegex(ValueError, "transcription provider"):
            render("abc123", secrets)


if __name__ == "__main__":
    unittest.main()
