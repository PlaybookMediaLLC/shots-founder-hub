begin;
select plan(19);

select tests.create_user('live_owner', 'live-owner@example.com');
select tests.create_user('live_editor', 'live-editor@example.com');
select tests.create_user('live_viewer', 'live-viewer@example.com');
select tests.create_user('live_other', 'live-other@example.com');

update founder_hub_identity.users
set email_confirmed_at = now()
where id in (
  tests.user_id('live_owner'),
  tests.user_id('live_editor'),
  tests.user_id('live_viewer'),
  tests.user_id('live_other')
);

select tests.authenticate_as_service_role();

insert into founder_hub.workspaces (id, owner_user_id, kind, name)
values (
  '61000000-0000-4000-8000-000000000001',
  tests.user_id('live_owner'),
  'shared',
  'Live workspace'
);

insert into founder_hub.workspace_memberships (workspace_id, user_id, role)
values (
  '61000000-0000-4000-8000-000000000001',
  tests.user_id('live_owner'),
  'owner'
);

insert into founder_hub.session_shares (
  id,
  workspace_id,
  session_id,
  created_by_user_id,
  general_scope
) values
  (
    '61000000-0000-4000-8000-000000000101',
    '61000000-0000-4000-8000-000000000001',
    'live-editable',
    tests.user_id('live_owner'),
    'restricted'
  ),
  (
    '61000000-0000-4000-8000-000000000102',
    '61000000-0000-4000-8000-000000000001',
    'live-locked',
    tests.user_id('live_owner'),
    'restricted'
  );

insert into founder_hub.session_share_snapshots (
  share_id,
  content_revision,
  title,
  body_json,
  published_by_user_id,
  web_editable
) values
  (
    '61000000-0000-4000-8000-000000000101',
    3,
    'Live title',
    '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,
    tests.user_id('live_owner'),
    true
  ),
  (
    '61000000-0000-4000-8000-000000000102',
    1,
    'Locked title',
    '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,
    tests.user_id('live_owner'),
    false
  );

insert into founder_hub.session_access_grants (
  share_id,
  grantee_user_id,
  capability,
  granted_by_user_id
) values
  (
    '61000000-0000-4000-8000-000000000101',
    tests.user_id('live_editor'),
    'editor',
    tests.user_id('live_owner')
  ),
  (
    '61000000-0000-4000-8000-000000000101',
    tests.user_id('live_viewer'),
    'viewer',
    tests.user_id('live_owner')
  ),
  (
    '61000000-0000-4000-8000-000000000102',
    tests.user_id('live_editor'),
    'editor',
    tests.user_id('live_owner')
  );

select results_eq(
  $$
    select capability, content_revision
    from founder_hub.resolve_session_share_live_access(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_owner')
    )
  $$,
  $$ values ('editor'::text, 3::bigint) $$,
  'workspace owner resolves as live editor'
);

select results_eq(
  $$
    select capability
    from founder_hub.resolve_session_share_live_access(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_editor')
    )
  $$,
  $$ values ('editor'::text) $$,
  'editor grant on web-editable snapshot resolves as live editor'
);

select results_eq(
  $$
    select capability
    from founder_hub.resolve_session_share_live_access(
      '61000000-0000-4000-8000-000000000102',
      tests.user_id('live_editor')
    )
  $$,
  $$ values ('viewer'::text) $$,
  'editor grant without web editing degrades to live viewer'
);

select results_eq(
  $$
    select capability
    from founder_hub.resolve_session_share_live_access(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_viewer')
    )
  $$,
  $$ values ('viewer'::text) $$,
  'viewer grant resolves as live viewer'
);

select is_empty(
  $$
    select *
    from founder_hub.resolve_session_share_live_access(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_other')
    )
  $$,
  'users without access resolve nothing'
);

select results_eq(
  $$
    select state_hex, compacted_through_seq, updates
    from founder_hub.read_session_share_live_document(
      '61000000-0000-4000-8000-000000000101'
    )
  $$,
  $$ values (null::text, 0::bigint, '[]'::jsonb) $$,
  'unseeded live document reads as empty'
);

select results_eq(
  $$
    select outcome, seq
    from founder_hub.append_session_share_live_update(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_editor'),
      '0102',
      true
    )
  $$,
  $$ values ('appended'::text, 1::bigint) $$,
  'first seed append succeeds'
);

select results_eq(
  $$
    select outcome, seq
    from founder_hub.append_session_share_live_update(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_owner'),
      '0304',
      true
    )
  $$,
  $$ values ('not_empty'::text, null::bigint) $$,
  'second seed append is rejected once the log has content'
);

select results_eq(
  $$
    select outcome, seq
    from founder_hub.append_session_share_live_update(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_owner'),
      '0304',
      false
    )
  $$,
  $$ values ('appended'::text, 2::bigint) $$,
  'regular appends take the next sequence'
);

select throws_ok(
  $$
    select *
    from founder_hub.append_session_share_live_update(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_viewer'),
      '0506',
      false
    )
  $$,
  '42501',
  'live document edit not permitted',
  'viewers cannot append live updates'
);

select throws_ok(
  $$
    select *
    from founder_hub.append_session_share_live_update(
      '61000000-0000-4000-8000-000000000102',
      tests.user_id('live_editor'),
      '0506',
      false
    )
  $$,
  '42501',
  'live document edit not permitted',
  'editors cannot append to shares without web editing'
);

select throws_ok(
  $$
    select *
    from founder_hub.append_session_share_live_update(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_owner'),
      'zz',
      false
    )
  $$,
  '22023',
  'invalid live document update',
  'malformed hex updates are rejected'
);

select results_eq(
  $$
    select seq, update_hex
    from founder_hub.read_session_share_live_updates(
      '61000000-0000-4000-8000-000000000101',
      0,
      100
    )
  $$,
  $$ values (1::bigint, '0102'::text), (2::bigint, '0304'::text) $$,
  'updates page in sequence order'
);

select results_eq(
  $$
    select seq, update_hex
    from founder_hub.read_session_share_live_updates(
      '61000000-0000-4000-8000-000000000101',
      1,
      100
    )
  $$,
  $$ values (2::bigint, '0304'::text) $$,
  'updates page after a cursor'
);

select results_eq(
  $$
    select share_id, compacted_through_seq
    from founder_hub.compact_session_share_live_document(
      '61000000-0000-4000-8000-000000000101',
      'aabb',
      2
    )
  $$,
  $$ values ('61000000-0000-4000-8000-000000000101'::uuid, 2::bigint) $$,
  'compaction records the covered sequence'
);

select results_eq(
  $$
    select state_hex, compacted_through_seq, updates
    from founder_hub.read_session_share_live_document(
      '61000000-0000-4000-8000-000000000101'
    )
  $$,
  $$ values ('aabb'::text, 2::bigint, '[]'::jsonb) $$,
  'compaction replaces the update log with state'
);

select results_eq(
  $$
    select share_id, compacted_through_seq
    from founder_hub.compact_session_share_live_document(
      '61000000-0000-4000-8000-000000000101',
      'ccdd',
      1
    )
  $$,
  $$ values ('61000000-0000-4000-8000-000000000101'::uuid, 2::bigint) $$,
  'stale compaction is ignored'
);

select results_eq(
  $$
    select outcome, seq
    from founder_hub.append_session_share_live_update(
      '61000000-0000-4000-8000-000000000101',
      tests.user_id('live_owner'),
      '0708',
      false
    )
  $$,
  $$ values ('appended'::text, 3::bigint) $$,
  'appends after compaction continue the sequence'
);

select tests.clear_authentication();
reset role;

select tests.authenticate_as('live_owner');

select throws_ok(
  $$
    select *
    from founder_hub.read_session_share_live_document(
      '61000000-0000-4000-8000-000000000101'
    )
  $$,
  '42501',
  null,
  'cloud_member users cannot call live document RPCs directly'
);

select tests.clear_authentication();

select * from finish();
rollback;
