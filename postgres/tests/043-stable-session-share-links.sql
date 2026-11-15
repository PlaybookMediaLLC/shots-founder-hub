begin;
select plan(8);

select tests.create_user(
  'stable_share_owner',
  'stable-share-owner@example.com'
);

update founder_hub_identity.users
set email_confirmed_at = now()
where id = tests.user_id('stable_share_owner');

create temporary table stable_share_test_state (
  name text primary key,
  workspace_id uuid,
  share_id uuid
);

grant all on stable_share_test_state to cloud_anonymous, cloud_member, cloud_service;

insert into stable_share_test_state (name, workspace_id)
values ('workspace', gen_random_uuid());

select tests.authenticate_as_service_role();

insert into founder_hub.workspaces (id, owner_user_id, kind, name)
select
  workspace_id,
  tests.user_id('stable_share_owner'),
  'shared',
  'Stable share workspace'
from stable_share_test_state
where name = 'workspace';

insert into founder_hub.workspace_memberships (workspace_id, user_id, role)
select
  workspace_id,
  tests.user_id('stable_share_owner'),
  'owner'
from stable_share_test_state
where name = 'workspace';

select tests.enable_workspace_plan(workspace_id)
from stable_share_test_state
where name = 'workspace';

select tests.clear_authentication();
select tests.authenticate_as_hyprnote_pro('stable_share_owner');

insert into stable_share_test_state (name, share_id)
select 'link', share_id
from founder_hub.create_session_share(
  (
    select workspace_id
    from stable_share_test_state
    where name = 'workspace'
  ),
  'stable-link-session'
);

insert into stable_share_test_state (name, share_id)
select 'public', share_id
from founder_hub.create_session_share(
  (
    select workspace_id
    from stable_share_test_state
    where name = 'workspace'
  ),
  'stable-public-session'
);

insert into stable_share_test_state (name, share_id)
select 'restricted', share_id
from founder_hub.create_session_share(
  (
    select workspace_id
    from stable_share_test_state
    where name = 'workspace'
  ),
  'stable-restricted-session'
);

select *
from founder_hub.enable_session_share_link(
  (select share_id from stable_share_test_state where name = 'link')
);

select *
from founder_hub.set_session_share_scope(
  (select share_id from stable_share_test_state where name = 'public'),
  'public'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();

select founder_hub.publish_session_share_snapshot(
  state.share_id,
  tests.user_id('stable_share_owner'),
  initcap(state.name) || ' stable note',
  '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb
)
from stable_share_test_state as state
where state.share_id is not null;

select ok(
  has_function_privilege(
    'cloud_service',
    'founder_hub.gateway_read_stable_session_share_snapshot_v2(uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'cloud_member',
      'founder_hub.gateway_read_stable_session_share_snapshot_v2(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'cloud_anonymous',
      'founder_hub.gateway_read_stable_session_share_snapshot_v2(uuid)',
      'EXECUTE'
    ),
  'Only the service gateway can resolve stable share URLs'
);

select results_eq(
  $query$
    select general_scope, share_id, title
    from founder_hub.gateway_read_stable_session_share_snapshot_v2(
      (select share_id from stable_share_test_state where name = 'link')
    )
  $query$,
  $query$
    select
      'link'::text,
      share_id,
      'Link stable note'::text
    from stable_share_test_state
    where name = 'link'
  $query$,
  'An active anyone-with-the-link share resolves through its stable share ID'
);

select results_eq(
  $query$
    select title
    from founder_hub.gateway_read_stable_session_share_preview(
      (select share_id from stable_share_test_state where name = 'link')
    )
  $query$,
  $$values ('Link stable note'::text)$$,
  'Stable URLs expose the existing bounded social preview'
);

select results_eq(
  $query$
    select general_scope, share_id
    from founder_hub.gateway_read_stable_session_share_snapshot_v2(
      (select share_id from stable_share_test_state where name = 'public')
    )
  $query$,
  $query$
    select 'public'::text, share_id
    from stable_share_test_state
    where name = 'public'
  $query$,
  'Public-on-the-web notes use the same stable share ID'
);

select is_empty(
  $query$
    select *
    from founder_hub.gateway_read_stable_session_share_snapshot_v2(
      (select share_id from stable_share_test_state where name = 'restricted')
    )
  $query$,
  'Restricted notes do not resolve anonymously through their stable URL'
);

select tests.clear_authentication();
select tests.authenticate_as_hyprnote_pro('stable_share_owner');
select *
from founder_hub.set_session_share_scope(
  (select share_id from stable_share_test_state where name = 'link'),
  'restricted'
);
select tests.clear_authentication();
select tests.authenticate_as_service_role();

select is_empty(
  $query$
    select *
    from founder_hub.gateway_read_stable_session_share_snapshot_v2(
      (select share_id from stable_share_test_state where name = 'link')
    )
  $query$,
  'Turning off link access immediately disables the stable URL'
);

select tests.clear_authentication();
select tests.authenticate_as_hyprnote_pro('stable_share_owner');
select *
from founder_hub.enable_session_share_link(
  (select share_id from stable_share_test_state where name = 'link')
);
select tests.clear_authentication();
select tests.authenticate_as_service_role();

select results_eq(
  $query$
    select share_id
    from founder_hub.gateway_read_stable_session_share_snapshot_v2(
      (select share_id from stable_share_test_state where name = 'link')
    )
  $query$,
  $query$
    select share_id
    from stable_share_test_state
    where name = 'link'
  $query$,
  'Re-enabling link access restores the same URL instead of rotating it'
);

select is(
  (
    select count(*)
    from founder_hub.gateway_create_stable_session_share_handoff(
      (select share_id from stable_share_test_state where name = 'link'),
      repeat('a', 64)
    )
  ),
  1::bigint,
  'The stable URL can create a desktop handoff without exposing a bearer token'
);

select * from finish();
rollback;
