CREATE TABLE founder_hub.workspaces (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES founder_hub_identity.users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'personal',
  name text NOT NULL DEFAULT 'Personal',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT workspaces_kind_check CHECK (kind = 'personal'),
  CONSTRAINT workspaces_personal_identity_check CHECK (id = owner_user_id)
);

CREATE TABLE founder_hub.workspace_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES founder_hub.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES founder_hub_identity.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT workspace_memberships_role_check CHECK (
    role IN ('owner', 'admin', 'member')
  ),
  CONSTRAINT workspace_memberships_workspace_user_key UNIQUE (workspace_id, user_id)
);

CREATE UNIQUE INDEX workspaces_personal_owner_key
  ON founder_hub.workspaces(owner_user_id)
  WHERE kind = 'personal' AND deleted_at IS NULL;

CREATE INDEX workspace_memberships_user_active_idx
  ON founder_hub.workspace_memberships(user_id, workspace_id)
  WHERE deleted_at IS NULL;

ALTER TABLE founder_hub.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_hub.workspace_memberships ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE founder_hub.workspaces FROM PUBLIC, cloud_anonymous, cloud_member;
REVOKE ALL ON TABLE founder_hub.workspace_memberships FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT SELECT ON TABLE founder_hub.workspaces TO cloud_member;
GRANT SELECT ON TABLE founder_hub.workspace_memberships TO cloud_member;
GRANT ALL ON TABLE founder_hub.workspaces TO cloud_service;
GRANT ALL ON TABLE founder_hub.workspace_memberships TO cloud_service;

CREATE POLICY workspaces_select_member
  ON founder_hub.workspaces
  FOR SELECT
  TO cloud_member
  USING (
    deleted_at IS NULL
    AND id IN (
      SELECT membership.workspace_id
      FROM founder_hub.workspace_memberships AS membership
      WHERE membership.user_id = (SELECT founder_hub_identity.user_id())
        AND membership.deleted_at IS NULL
    )
  );

CREATE POLICY workspaces_service_all
  ON founder_hub.workspaces
  FOR ALL
  TO cloud_service
  USING (true)
  WITH CHECK (true);

CREATE POLICY workspace_memberships_select_self
  ON founder_hub.workspace_memberships
  FOR SELECT
  TO cloud_member
  USING (
    user_id = (SELECT founder_hub_identity.user_id())
    AND deleted_at IS NULL
  );

CREATE POLICY workspace_memberships_service_all
  ON founder_hub.workspace_memberships
  FOR ALL
  TO cloud_service
  USING (true)
  WITH CHECK (true);

CREATE SCHEMA IF NOT EXISTS founder_hub_private;
REVOKE ALL ON SCHEMA founder_hub_private FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT USAGE ON SCHEMA founder_hub_private TO cloud_identity_admin;

CREATE OR REPLACE FUNCTION founder_hub_private.handle_new_user_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(NEW.is_anonymous, false) THEN
    RETURN NEW;
  END IF;

  INSERT INTO founder_hub.workspaces (id, owner_user_id, kind)
  VALUES (NEW.id, NEW.id, 'personal')
  ON CONFLICT (id) DO UPDATE SET
    deleted_at = NULL,
    updated_at = now();

  INSERT INTO founder_hub.workspace_memberships (id, workspace_id, user_id, role)
  VALUES (NEW.id, NEW.id, NEW.id, 'owner')
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET
    role = 'owner',
    deleted_at = NULL,
    updated_at = now();

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub_private.handle_new_user_workspace() FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub_private.handle_new_user_workspace() TO cloud_identity_admin;

DROP TRIGGER IF EXISTS on_auth_user_workspace_created ON founder_hub_identity.users;
CREATE TRIGGER on_auth_user_workspace_created
  AFTER INSERT ON founder_hub_identity.users
  FOR EACH ROW EXECUTE FUNCTION founder_hub_private.handle_new_user_workspace();

INSERT INTO founder_hub.workspaces (
  id,
  owner_user_id,
  kind,
  name,
  created_at,
  updated_at
)
SELECT id, id, 'personal', 'Personal', created_at, created_at
FROM founder_hub_identity.users
WHERE COALESCE(is_anonymous, false) = false
ON CONFLICT (id) DO NOTHING;

INSERT INTO founder_hub.workspace_memberships (
  id,
  workspace_id,
  user_id,
  role,
  created_at,
  updated_at
)
SELECT id, id, id, 'owner', created_at, created_at
FROM founder_hub_identity.users
WHERE COALESCE(is_anonymous, false) = false
ON CONFLICT (workspace_id, user_id) DO UPDATE SET
  role = 'owner',
  deleted_at = NULL,
  updated_at = now();
