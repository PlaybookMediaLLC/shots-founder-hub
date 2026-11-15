DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['cloud_owner','cloud_anonymous','cloud_member','cloud_service','cloud_identity_admin','cloud_api','shots_hub_authenticated','shots_hub_service_role'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', name);
    END IF;
  END LOOP;
END;
$$;

DO $$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO cloud_owner', current_database());
END $$;

GRANT cloud_anonymous, cloud_member, cloud_service TO cloud_api;
GRANT cloud_member TO shots_hub_authenticated;
ALTER ROLE shots_hub_authenticated INHERIT;
ALTER ROLE cloud_service BYPASSRLS;
GRANT cloud_service TO shots_hub_service_role;
ALTER ROLE shots_hub_service_role INHERIT BYPASSRLS;
CREATE SCHEMA IF NOT EXISTS founder_hub AUTHORIZATION cloud_owner;
CREATE SCHEMA IF NOT EXISTS founder_hub_identity AUTHORIZATION cloud_owner;
CREATE SCHEMA IF NOT EXISTS founder_hub_files AUTHORIZATION cloud_owner;
CREATE SCHEMA IF NOT EXISTS founder_hub_private AUTHORIZATION cloud_owner;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE, CREATE ON SCHEMA founder_hub, extensions TO cloud_owner;
GRANT USAGE ON SCHEMA founder_hub, founder_hub_identity, founder_hub_files, extensions TO cloud_anonymous, cloud_member, cloud_service, cloud_identity_admin;
GRANT USAGE ON SCHEMA founder_hub_private TO cloud_service, cloud_identity_admin;

SET LOCAL ROLE cloud_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA founder_hub GRANT ALL ON TABLES TO cloud_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA founder_hub GRANT ALL ON SEQUENCES TO cloud_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA founder_hub GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cloud_anonymous, cloud_member;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA founder_hub GRANT EXECUTE ON FUNCTIONS TO cloud_anonymous, cloud_member, cloud_service;

CREATE TABLE IF NOT EXISTS founder_hub_identity.users (
  id uuid PRIMARY KEY,
  aud text,
  role text,
  email text,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz GENERATED ALWAYS AS (least(email_confirmed_at, phone_confirmed_at)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  is_anonymous boolean NOT NULL DEFAULT false,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}',
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'
);
CREATE OR REPLACE FUNCTION founder_hub_identity.claims() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.identity', true), '')::jsonb, nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
CREATE OR REPLACE FUNCTION founder_hub_identity.user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(founder_hub_identity.claims()->>'sub', '')::uuid
$$;
GRANT ALL ON founder_hub_identity.users TO cloud_service;
GRANT EXECUTE ON FUNCTION founder_hub_identity.claims(), founder_hub_identity.user_id() TO cloud_anonymous, cloud_member, cloud_service, cloud_identity_admin;

CREATE TABLE IF NOT EXISTS founder_hub_files.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS founder_hub_files.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL REFERENCES founder_hub_files.buckets(id),
  name text NOT NULL,
  owner text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, name)
);
ALTER TABLE founder_hub_files.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON ALL TABLES IN SCHEMA founder_hub_files TO cloud_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON founder_hub_files.objects TO cloud_member;
CREATE OR REPLACE FUNCTION founder_hub_files.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[1:cardinality(string_to_array(name, '/')) - 1]
$$;
GRANT EXECUTE ON FUNCTION founder_hub_files.foldername(text) TO cloud_anonymous, cloud_member, cloud_service;
