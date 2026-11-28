CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS tests;
GRANT USAGE ON SCHEMA tests, extensions TO cloud_anonymous, cloud_member, cloud_service, cloud_identity_admin;
CREATE TABLE IF NOT EXISTS tests.users (identifier text PRIMARY KEY, id uuid NOT NULL);
GRANT SELECT ON tests.users TO cloud_anonymous, cloud_member, cloud_service, cloud_identity_admin;
CREATE OR REPLACE FUNCTION tests.create_user(identifier text, email text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE user_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO tests.users VALUES(identifier,user_id);
  INSERT INTO founder_hub_identity.users(id,email,aud,role,email_confirmed_at)
    VALUES(user_id,coalesce(email,identifier || '@example.test'),'authenticated','cloud_member',now());
  RETURN user_id;
END $$;
CREATE OR REPLACE FUNCTION tests.user_id(value text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT coalesce((SELECT id FROM tests.users WHERE identifier=value), (SELECT id FROM founder_hub_identity.users WHERE raw_user_meta_data->>'test_identifier'=value))
$$;
CREATE OR REPLACE FUNCTION tests.authenticate_as(identifier text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE claims jsonb;
BEGIN
  RESET ROLE;
  SELECT jsonb_build_object('sub', u.id, 'email', u.email, 'role','cloud_member','aud','authenticated') INTO claims
    FROM founder_hub_identity.users u WHERE u.id=tests.user_id(identifier);
  PERFORM set_config('request.identity',claims::text,true);
  SET LOCAL ROLE cloud_member;
END $$;
CREATE OR REPLACE FUNCTION tests.authenticate_as_service_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.identity','{"role":"cloud_service"}',true);
  SET LOCAL ROLE cloud_service;
END $$;
CREATE OR REPLACE FUNCTION tests.clear_authentication() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.identity','{}',true);
END $$;
create or replace function tests.authenticate_as_hyprnote_pro(identifier text)
returns void
language plpgsql
set search_path = ''
as $$
declare
    claims jsonb;
begin
    perform tests.authenticate_as(identifier);
    claims := coalesce(
        current_setting('request.identity', true)::jsonb,
        '{}'::jsonb
    );
    perform set_config(
        'request.identity',
        jsonb_set(
            claims,
            '{entitlements}',
            '["hyprnote_pro"]'::jsonb,
            true
        )::text,
        true
    );
end;
$$;

create or replace function tests.enable_workspace_plan(
    workspace_id uuid,
    plan_name text default 'team',
    seats integer default 100
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    customer_id text := 'cus_test_' || replace(workspace_id::text, '-', '');
    subscription_id text := 'sub_test_' || replace(workspace_id::text, '-', '');
    entitlement_key text;
begin
    if plan_name not in ('team', 'enterprise') then
        raise exception 'unsupported workspace test plan';
    end if;

    entitlement_key := case plan_name
        when 'team' then 'hyprnote_team'
        else 'hyprnote_enterprise'
    end;

    insert into stripe.customers (id)
    values (customer_id)
    on conflict (id) do nothing;

    update founder_hub.workspaces
    set
        stripe_customer_id = customer_id,
        seat_limit = seats
    where id = workspace_id;

    insert into stripe.subscriptions (id, customer, status)
    values (
        subscription_id,
        customer_id,
        'active'::stripe.subscription_status
    )
    on conflict (id) do update set
        customer = excluded.customer,
        status = excluded.status;

    insert into stripe.active_entitlements (id, customer, lookup_key)
    values (
        'ent_test_' || replace(workspace_id::text, '-', '') || '_' || plan_name,
        customer_id,
        entitlement_key
    )
    on conflict (customer, lookup_key) do nothing;

    insert into stripe.active_entitlements (id, customer, lookup_key)
    values (
        'ent_test_' || replace(workspace_id::text, '-', '') || '_pro',
        customer_id,
        'hyprnote_pro'
    )
    on conflict (customer, lookup_key) do nothing;
end;
$$;
