import unittest
from prepare_api_service_secrets import AI, CORE, SHARED, SHOTS, SYNC, select


class ServiceSecretsTests(unittest.TestCase):
    def setUp(self):
        self.api = [
            {"key": key, "value": "test-value"}
            for key in SHARED | AI | CORE | SYNC | SHOTS | {"FOUNDER_HUB_MCP_URL"}
        ]
        self.api += [
            {"key": key, "value": "unrelated"}
            for key in [
                "SUPABASE_SERVICE_ROLE_KEY",
                "STRIPE_SECRET_KEY",
                "OTA_S3_SECRET_ACCESS_KEY",
            ]
        ]

    def test_services_receive_direct_database_storage_and_shots_credentials_only(self):
        for role, excluded in [("ai", CORE | SYNC), ("sync", AI | CORE), ("core", AI)]:
            with self.subTest(role=role):
                result = select(role, self.api, [])
                self.assertFalse(result.keys() & excluded)
                self.assertTrue(SHOTS <= result.keys())
                self.assertIn("DATABASE_URL", result)
                self.assertIn("R2_SECRET_ACCESS_KEY", result)
                self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", result)
                self.assertNotIn("STRIPE_SECRET_KEY", result)
                self.assertNotIn("OTA_S3_SECRET_ACCESS_KEY", result)

    def test_missing_or_conflicting_configuration_fails_without_secret_values(self):
        with self.assertRaisesRegex(ValueError, "Missing"):
            select("core", [], [])
        with self.assertRaisesRegex(ValueError, "Conflicting secret: DATABASE_URL"):
            select("core", self.api, [{"key": "DATABASE_URL", "value": "different"}])
        for role in ["billing", "misspelled"]:
            with self.assertRaisesRegex(ValueError, "Unknown"):
                select(role, self.api, [])

    def test_callback_origin_belongs_to_ai_service(self):
        self.assertEqual(
            select("ai", self.api, [])["API_BASE_URL"],
            "https://anarlog-inference.fly.dev",
        )
        self.assertEqual(select("all", self.api, [])["API_BASE_URL"], "test-value")

    def test_authority_and_public_mcp_configuration_is_required(self):
        for key in [
            "SHOTS_AUTH_SERVICE_TOKEN",
            "FOUNDER_HUB_MCP_URL",
            "CLOUD_SIGNING_KEY",
            "R2_BUCKET",
        ]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                select("sync", [s for s in self.api if s["key"] != key], [])


if __name__ == "__main__":
    unittest.main()
