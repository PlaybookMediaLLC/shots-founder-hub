CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text
);

ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "founder_hub_identity"."users"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "profiles_stripe_customer_id_idx" ON "profiles" ("stripe_customer_id");

CREATE POLICY "profiles_select_owner" ON "profiles" AS PERMISSIVE FOR SELECT TO "cloud_member" USING ((select founder_hub_identity.user_id()) = id);

CREATE POLICY "profiles_insert_owner" ON "profiles" AS PERMISSIVE FOR INSERT TO "cloud_member" WITH CHECK ((select founder_hub_identity.user_id()) = id);

CREATE POLICY "profiles_update_owner" ON "profiles" AS PERMISSIVE FOR UPDATE TO "cloud_member" USING ((select founder_hub_identity.user_id()) = id) WITH CHECK ((select founder_hub_identity.user_id()) = id);

CREATE POLICY "profiles_delete_owner" ON "profiles" AS PERMISSIVE FOR DELETE TO "cloud_member" USING ((select founder_hub_identity.user_id()) = id);

CREATE POLICY "profiles_service_all" ON "profiles" AS PERMISSIVE FOR ALL TO "cloud_service" USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION founder_hub.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO founder_hub.profiles (id)
  VALUES (new.id);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON founder_hub_identity.users
  FOR EACH ROW EXECUTE FUNCTION founder_hub.handle_new_user();
