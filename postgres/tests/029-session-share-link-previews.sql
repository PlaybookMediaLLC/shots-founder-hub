begin;
select plan(7);

select tests.create_user(
  'link_preview_owner',
  'link-preview-owner@example.com'
);

update founder_hub_identity.users
set email_confirmed_at = now()
where id = tests.user_id('link_preview_owner');

create temporary table link_preview_test_state (
  name text primary key,
  workspace_id uuid,
  share_id uuid,
  secret text
);

grant all on link_preview_test_state to cloud_anonymous, cloud_member, cloud_service;

insert into link_preview_test_state (name, workspace_id)
values ('workspace', gen_random_uuid());

select tests.authenticate_as_service_role();

insert into founder_hub.workspaces (id, owner_user_id, kind, name)
select
  workspace_id,
  tests.user_id('link_preview_owner'),
  'shared',
  'Link preview workspace'
from link_preview_test_state
where name = 'workspace';

insert into founder_hub.workspace_memberships (workspace_id, user_id, role)
select
  workspace_id,
  tests.user_id('link_preview_owner'),
  'owner'
from link_preview_test_state
where name = 'workspace';

select tests.enable_workspace_plan(workspace_id)
from link_preview_test_state
where name = 'workspace';

select tests.clear_authentication();
select tests.authenticate_as_hyprnote_pro('link_preview_owner');

select lives_ok(
  $query$
    insert into link_preview_test_state (name, share_id)
    select 'share', share_id
    from founder_hub.create_session_share(
      (select workspace_id from link_preview_test_state where name = 'workspace'),
      'link-preview-session'
    )
  $query$,
  'The owner can create the link preview fixture'
);

select lives_ok(
  $query$
    insert into link_preview_test_state (name, share_id, secret)
    select 'active_link', share_id, link_token
    from founder_hub.enable_session_share_link(
      (select share_id from link_preview_test_state where name = 'share')
    )
  $query$,
  'The owner can create a bearer link'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();

select lives_ok(
  $$
    select *
    from founder_hub.publish_session_share_snapshot(
      (select share_id from link_preview_test_state where name = 'share'),
      tests.user_id('link_preview_owner'),
      'Planning & decisions',
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Ship the stable release."}]}]}'::jsonb
    )
  $$,
  'Trusted publication creates the preview snapshot'
);

select ok(
  has_function_privilege(
    'cloud_service',
    'founder_hub.gateway_read_session_share_link_preview(uuid,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'cloud_anonymous',
      'founder_hub.gateway_read_session_share_link_preview(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'cloud_member',
      'founder_hub.gateway_read_session_share_link_preview(uuid,text)',
      'EXECUTE'
    ),
  'Only service role can execute the link preview gateway'
);

select is(
  (
    select
      snapshot.title = 'Planning & decisions'
        and snapshot.participants = ARRAY[]::text[]
        and snapshot.meeting_at is not null
    from founder_hub.gateway_read_session_share_link_preview(
      (select share_id from link_preview_test_state where name = 'share'),
      (
        select encode(extensions.digest(secret, 'sha256'), 'hex')
        from link_preview_test_state
        where name = 'active_link'
      )
    ) as snapshot
  ),
  true,
  'The digest-derived preview capability returns only social metadata fields'
);

select is(
  (
    select count(*)
    from founder_hub.gateway_read_session_share_link_preview(
      (select share_id from link_preview_test_state where name = 'share'),
      repeat('0', 64)
    )
  ),
  0::bigint,
  'An unrelated preview capability cannot read metadata'
);

select is(
  (
    select count(*)
    from founder_hub.gateway_read_session_share_link_preview(
      (select share_id from link_preview_test_state where name = 'share'),
      repeat('A', 64)
    )
  ),
  0::bigint,
  'Preview capabilities must use canonical lowercase hex'
);

select * from finish();
rollback;
