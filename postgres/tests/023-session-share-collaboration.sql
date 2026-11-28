begin;
select plan(48);

select tests.create_user('collab_owner', 'collab-owner@example.com');
select tests.create_user('collab_manager', 'collab-manager@example.com');
select tests.create_user('collab_commenter', 'collab-commenter@example.com');
select tests.create_user('collab_editor', 'collab-editor@example.com');
select tests.create_user('collab_viewer', 'collab-viewer@example.com');
select tests.create_user('collab_other', 'collab-other@example.com');
select tests.create_user('collab_revoked', 'collab-revoked@example.com');
select tests.create_user('collab_requester', 'collab-requester@example.com');
select tests.create_user('collab_invitee', 'collab-invitee@example.com');
select tests.create_user('collab_wrong', 'collab-wrong@example.com');

create temporary table session_share_collaboration_test_state (
  name text primary key,
  workspace_id uuid,
  share_id uuid,
  entity_id uuid,
  secret text,
  body text,
  revision bigint
);

grant all on session_share_collaboration_test_state
  to cloud_anonymous, cloud_member, cloud_service;

insert into session_share_collaboration_test_state (
  name,
  workspace_id,
  share_id
) values (
  'share',
  gen_random_uuid(),
  gen_random_uuid()
);

insert into session_share_collaboration_test_state (
  name,
  workspace_id
) values (
  'anonymous_user',
  gen_random_uuid()
);

insert into session_share_collaboration_test_state (
  name,
  entity_id,
  secret
) values (
  'invitation',
  gen_random_uuid(),
  repeat('i', 43)
);

insert into founder_hub_identity.users (
  id,
  raw_user_meta_data,
  raw_app_meta_data,
  is_anonymous,
  created_at,
  updated_at
)
select
  workspace_id,
  jsonb_build_object('test_identifier', 'collab_anonymous'),
  '{}'::jsonb,
  true,
  now(),
  now()
from session_share_collaboration_test_state
where name = 'anonymous_user';

update founder_hub_identity.users
set email_confirmed_at = now()
where id in (
  tests.user_id('collab_owner'),
  tests.user_id('collab_manager'),
  tests.user_id('collab_commenter'),
  tests.user_id('collab_editor'),
  tests.user_id('collab_viewer'),
  tests.user_id('collab_other'),
  tests.user_id('collab_revoked'),
  tests.user_id('collab_requester'),
  tests.user_id('collab_invitee'),
  tests.user_id('collab_wrong')
);

select tests.authenticate_as_service_role();

insert into founder_hub.workspaces (id, owner_user_id, kind, name)
select
  workspace_id,
  tests.user_id('collab_owner'),
  'shared',
  'Session collaboration workspace'
from session_share_collaboration_test_state
where name = 'share';

insert into founder_hub.workspace_memberships (workspace_id, user_id, role)
select
  workspace_id,
  tests.user_id('collab_owner'),
  'owner'
from session_share_collaboration_test_state
where name = 'share'
union all
select
  workspace_id,
  tests.user_id('collab_manager'),
  'admin'
from session_share_collaboration_test_state
where name = 'share'
union all
select
  workspace_id,
  tests.user_id('collab_other'),
  'member'
from session_share_collaboration_test_state
where name = 'share';

select tests.enable_workspace_plan(workspace_id)
from session_share_collaboration_test_state
where name = 'share';

insert into founder_hub.session_shares (
  id,
  workspace_id,
  session_id,
  created_by_user_id
)
select
  share_id,
  workspace_id,
  'collaboration-session',
  tests.user_id('collab_owner')
from session_share_collaboration_test_state
where name = 'share';

insert into founder_hub.session_share_snapshots (
  share_id,
  content_revision,
  title,
  body_json,
  published_by_user_id
)
select
  share_id,
  7,
  'Collaboration fixture',
  '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,
  tests.user_id('collab_owner')
from session_share_collaboration_test_state
where name = 'share';

insert into founder_hub.session_access_grants (
  share_id,
  grantee_user_id,
  capability,
  granted_by_user_id,
  revoked_by_user_id,
  revoked_at
)
select
  share_id,
  tests.user_id('collab_commenter'),
  'commenter',
  tests.user_id('collab_owner'),
  null::uuid,
  null::timestamptz
from session_share_collaboration_test_state
where name = 'share'
union all
select
  share_id,
  tests.user_id('collab_editor'),
  'editor',
  tests.user_id('collab_owner'),
  null::uuid,
  null::timestamptz
from session_share_collaboration_test_state
where name = 'share'
union all
select
  share_id,
  tests.user_id('collab_viewer'),
  'viewer',
  tests.user_id('collab_owner'),
  null::uuid,
  null::timestamptz
from session_share_collaboration_test_state
where name = 'share'
union all
select
  share_id,
  tests.user_id('collab_revoked'),
  'commenter',
  tests.user_id('collab_owner'),
  tests.user_id('collab_owner'),
  now()
from session_share_collaboration_test_state
where name = 'share';

insert into founder_hub.session_access_invitations (
  id,
  share_id,
  invitee_email,
  invitee_user_id,
  capability,
  token_hash,
  invited_by_user_id,
  expires_at
)
select
  invitation.entity_id,
  share.share_id,
  'collab-invitee@example.com',
  tests.user_id('collab_invitee'),
  'commenter',
  extensions.digest(invitation.secret, 'sha256'),
  tests.user_id('collab_owner'),
  now() + interval '30 days'
from session_share_collaboration_test_state as invitation
cross join session_share_collaboration_test_state as share
where invitation.name = 'invitation'
  and share.name = 'share';

select tests.clear_authentication();
reset role;

select ok(
  (
    select class.relrowsecurity
    from pg_class as class
    join pg_namespace as namespace
      on namespace.oid = class.relnamespace
    where namespace.nspname = 'founder_hub'
      and class.relname = 'session_share_comments'
  ),
  'The shared comment table has row-level security enabled'
);

select ok(
  not exists (
    select 1
    from information_schema.table_privileges as privilege
    where privilege.table_schema = 'founder_hub'
      and privilege.table_name = 'session_share_comments'
      and privilege.grantee in ('PUBLIC', 'cloud_anonymous', 'cloud_member')
  )
    and has_table_privilege(
      'cloud_service',
      'founder_hub.session_share_comments',
      'SELECT, INSERT, UPDATE, DELETE'
    ),
  'Shared comments are hidden from clients and writable by trusted service code'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'founder_hub.session_share_comments'::regclass
      and conname = 'session_share_comments_revision_check'
  )
    and exists (
      select 1
      from pg_constraint
      where conrelid = 'founder_hub.session_share_comments'::regclass
        and conname = 'session_share_comments_body_check'
    )
    and exists (
      select 1
      from pg_indexes
      where schemaname = 'founder_hub'
        and tablename = 'session_share_comments'
        and indexname = 'session_share_comments_active_feed_idx'
        and indexdef ilike '%where (deleted_at is null)%'
    ),
  'Shared comments constrain revisions and bodies and have an active feed index'
);

select results_eq(
  $$
    select count(*)
    from pg_indexes
    where schemaname = 'founder_hub'
      and indexname in (
        'session_access_requests_history_idx',
        'session_access_events_subject_created_idx'
      )
  $$,
  array[2::bigint],
  'Collaboration request and subject event lookups have targeted indexes'
);

select ok(
  (
    select count(*) = 6
      and bool_and(not proc.prosecdef)
      and bool_and(
        'search_path=""' = any(coalesce(proc.proconfig, array[]::text[]))
      )
    from pg_proc as proc
    join pg_namespace as namespace
      on namespace.oid = proc.pronamespace
    where namespace.nspname = 'founder_hub'
      and proc.proname in (
        'create_session_share_comment',
        'list_session_share_comments',
        'delete_session_share_comment',
        'get_my_session_access_request',
        'list_session_share_access_page',
        'inspect_my_session_access_invitation'
      )
  ),
  'Public collaboration wrappers are hardened security invokers'
);

select ok(
  (
    select count(*) = 6
      and bool_and(proc.prosecdef)
      and bool_and(
        'search_path=""' = any(coalesce(proc.proconfig, array[]::text[]))
      )
    from pg_proc as proc
    join pg_namespace as namespace
      on namespace.oid = proc.pronamespace
    where namespace.nspname = 'founder_hub_private'
      and proc.proname in (
        'create_session_share_comment',
        'list_session_share_comments',
        'delete_session_share_comment',
        'get_my_session_access_request',
        'list_session_share_access_page',
        'inspect_my_session_access_invitation'
      )
  ),
  'Private collaboration implementations use hardened security definers'
);

select ok(
  (
    select count(*) = 6
      and bool_and(has_function_privilege('cloud_member', proc.oid, 'EXECUTE'))
      and bool_and(not has_function_privilege('cloud_anonymous', proc.oid, 'EXECUTE'))
    from pg_proc as proc
    join pg_namespace as namespace
      on namespace.oid = proc.pronamespace
    where namespace.nspname = 'founder_hub'
      and proc.proname in (
        'create_session_share_comment',
        'list_session_share_comments',
        'delete_session_share_comment',
        'get_my_session_access_request',
        'list_session_share_access_page',
        'inspect_my_session_access_invitation'
      )
  ),
  'Only cloud_member database clients can execute collaboration wrappers'
);

select ok(
  (
    select count(*) = 2
      and bool_and('is_author' = any(proc.proargnames))
      and bool_and(not ('author_user_id' = any(proc.proargnames)))
    from pg_proc as proc
    join pg_namespace as namespace
      on namespace.oid = proc.pronamespace
    where namespace.nspname = 'founder_hub'
      and proc.proname in (
        'create_session_share_comment',
        'list_session_share_comments'
      )
  ),
  'Public comment results expose author ownership without stable user identifiers'
);

select tests.authenticate_as('collab_owner');

select throws_ok(
  $$select count(*) from founder_hub.session_share_comments$$,
  '42501',
  'permission denied for table session_share_comments',
  'Authenticated clients cannot read comment rows directly'
);

select lives_ok(
  $$
    insert into session_share_collaboration_test_state (
      name,
      share_id,
      entity_id,
      body,
      revision
    )
    select
      'owner_comment',
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      comment_id,
      body,
      snapshot_content_revision
    from founder_hub.create_session_share_comment(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      '  Owner comment  '
    )
  $$,
  'A source workspace owner can create a comment'
);

select results_eq(
  $$
    select body, revision
    from session_share_collaboration_test_state
    where name = 'owner_comment'
  $$,
  $$values ('Owner comment'::text, 7::bigint)$$,
  'Comment creation trims the body and records the current snapshot revision'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_commenter');

select lives_ok(
  $$
    insert into session_share_collaboration_test_state (
      name,
      share_id,
      entity_id,
      body,
      revision
    )
    select
      'commenter_comment',
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      comment_id,
      body,
      snapshot_content_revision
    from founder_hub.create_session_share_comment(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      'Commenter comment'
    )
  $$,
  'A named Commenter can create a comment without a Pro entitlement'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_editor');

select lives_ok(
  $$
    insert into session_share_collaboration_test_state (
      name,
      share_id,
      entity_id,
      body,
      revision
    )
    select
      'editor_comment',
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      comment_id,
      body,
      snapshot_content_revision
    from founder_hub.create_session_share_comment(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      'Editor comment'
    )
  $$,
  'A named Editor can create a comment without a Pro entitlement'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_viewer');

select throws_ok(
  $$
    select *
    from founder_hub.create_session_share_comment(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      'Viewer write'
    )
  $$,
  '42501',
  'session comment operation not permitted',
  'A named Viewer cannot create a comment'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_anonymous');

select throws_ok(
  $$
    select *
    from founder_hub.create_session_share_comment(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      'Anonymous write'
    )
  $$,
  '42501',
  'session access operation not permitted',
  'An anonymous Auth identity cannot create a comment'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_other');

select throws_ok(
  $$
    select *
    from founder_hub.create_session_share_comment(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      'Ungranted write'
    )
  $$,
  '42501',
  'session comment operation not permitted',
  'An ungranted permanent user cannot create a comment'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_revoked');

select throws_ok(
  $$
    select *
    from founder_hub.create_session_share_comment(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      'Revoked write'
    )
  $$,
  '42501',
  'session comment operation not permitted',
  'A revoked Commenter cannot create a comment'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_owner');

select throws_ok(
  $$
    select *
    from founder_hub.create_session_share_comment(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      E' \t\n\r\v\f '
    )
  $$,
  '22023',
  'invalid session comment',
  'Whitespace-only comment bodies are rejected'
);

select throws_ok(
  $$
    select *
    from founder_hub.create_session_share_comment(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      repeat('x', 16385)
    )
  $$,
  '22023',
  'invalid session comment',
  'Comment bodies larger than sixteen KiB are rejected'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_viewer');

select results_eq(
  $$
    select count(*)
    from founder_hub.list_session_share_comments(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    )
  $$,
  array[3::bigint],
  'An invited Viewer with an active individual grant can list comments'
);

select results_eq(
  $$
    select count(*), min(snapshot_content_revision), max(snapshot_content_revision)
    from founder_hub.list_session_share_comments(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    )
  $$,
  $$values (3::bigint, 7::bigint, 7::bigint)$$,
  'Every created comment is tied to the published snapshot revision'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as_service_role();

update founder_hub.session_shares
set
  general_scope = 'public',
  general_workspace_id = null
where id = (
  select share_id
  from session_share_collaboration_test_state
  where name = 'share'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('collab_other');

select throws_ok(
  $$
    select *
    from founder_hub.list_session_share_comments(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    )
  $$,
  '42501',
  'session comment operation not permitted',
  'Public viewers without an individual grant receive an explicit comment-access denial'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as_service_role();

update founder_hub.session_shares
set
  general_scope = 'workspace',
  general_workspace_id = (
    select workspace_id
    from session_share_collaboration_test_state
    where name = 'share'
  )
where id = (
  select share_id
  from session_share_collaboration_test_state
  where name = 'share'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('collab_other');

select throws_ok(
  $$
    select *
    from founder_hub.list_session_share_comments(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    )
  $$,
  '42501',
  'session comment operation not permitted',
  'Workspace viewers without an individual grant receive an explicit comment-access denial'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as_service_role();

update founder_hub.session_shares
set
  general_scope = 'restricted',
  general_workspace_id = null
where id = (
  select share_id
  from session_share_collaboration_test_state
  where name = 'share'
);

insert into founder_hub.session_share_comments (
  share_id,
  author_user_id,
  snapshot_content_revision,
  body,
  created_at
)
select
  state.share_id,
  tests.user_id('collab_owner'),
  7,
  format('pagination-comment-%s', lpad(series.value::text, 3, '0')),
  now() + interval '1 day' + series.value * interval '1 second'
from session_share_collaboration_test_state as state
cross join generate_series(1, 101) as series(value)
where state.name = 'share';

insert into session_share_collaboration_test_state (
  name,
  entity_id,
  secret
)
select
  'comment_cursor',
  comment.id,
  comment.created_at::text
from founder_hub.session_share_comments as comment
where comment.body = 'pagination-comment-002';

select tests.clear_authentication();
reset role;
select tests.authenticate_as('collab_viewer');

select results_eq(
  $$
    select
      count(*),
      bool_or(body = 'pagination-comment-001'),
      bool_or(body = 'pagination-comment-101')
    from founder_hub.list_session_share_comments(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    )
  $$,
  $$values (100::bigint, false, true)$$,
  'The initial comment page returns the newest one hundred active comments'
);

select results_eq(
  $$
    select
      count(*),
      bool_or(body = 'pagination-comment-001'),
      bool_or(body = 'pagination-comment-002'),
      bool_or(body = 'pagination-comment-101')
    from founder_hub.list_session_share_comments(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      (
        select secret::timestamptz
        from session_share_collaboration_test_state
        where name = 'comment_cursor'
      ),
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'comment_cursor'
      ),
      100
    )
  $$,
  $$values (4::bigint, true, false, false)$$,
  'A comment cursor loads only the earlier active history'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_requester');

select lives_ok(
  $$
    insert into session_share_collaboration_test_state (
      name,
      share_id,
      entity_id
    )
    select
      'access_request',
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      request_id
    from founder_hub.request_session_access(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      'commenter'
    )
  $$,
  'An ungranted permanent user can request Commenter access'
);

select results_eq(
  $$
    select requested_capability, status, reviewed_at is null
    from founder_hub.get_my_session_access_request(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    )
  $$,
  $$values ('commenter'::text, 'pending'::text, true)$$,
  'A requester can read their own latest request state'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_owner');

select results_eq(
  $$
    select user_email, capability, status
    from founder_hub.list_session_share_access_page(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      null,
      null,
      100
    )
    where entry_id = (
      select entity_id
      from session_share_collaboration_test_state
      where name = 'access_request'
    )
  $$,
  $$values ('collab-requester@example.com'::text, 'commenter'::text, 'pending'::text)$$,
  'A manager can identify the account behind a pending request'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_requester');

select lives_ok(
  $$
    select *
    from founder_hub.cancel_session_access_request(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'access_request'
      )
    )
  $$,
  'A requester can cancel their pending access request'
);

select throws_ok(
  $$
    select *
    from founder_hub.request_session_access(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      'commenter'
    )
  $$,
  '22023',
  'session access request is rate limited',
  'A requester cannot recreate a cancelled request during the cooldown'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_other');

select results_eq(
  $$
    select count(*)
    from founder_hub.get_my_session_access_request(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    )
  $$,
  array[0::bigint],
  'Another user cannot inspect the requester state'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_invitee');

select results_eq(
  $$
    select status, capability, share_id is null
    from founder_hub.inspect_my_session_access_invitation(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'invitation'
      ),
      (
        select secret
        from session_share_collaboration_test_state
        where name = 'invitation'
      )
    )
  $$,
  $$values ('pending'::text, 'commenter'::text, true)$$,
  'The intended recipient can inspect a pending invitation without note metadata'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_wrong');

select results_eq(
  $$
    select count(*)
    from founder_hub.inspect_my_session_access_invitation(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'invitation'
      ),
      (
        select secret
        from session_share_collaboration_test_state
        where name = 'invitation'
      )
    )
  $$,
  array[0::bigint],
  'A valid invitation token reveals no state to the wrong account'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_invitee');

select lives_ok(
  $$
    insert into session_share_collaboration_test_state (
      name,
      share_id,
      entity_id
    )
    select
      'accepted_grant',
      share_id,
      grant_id
    from founder_hub.accept_session_access_invitation(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'invitation'
      ),
      (
        select secret
        from session_share_collaboration_test_state
        where name = 'invitation'
      )
    )
  $$,
  'The intended recipient can accept the inspected invitation'
);

select results_eq(
  $$
    select
      status,
      capability,
      share_id = (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    from founder_hub.inspect_my_session_access_invitation(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'invitation'
      ),
      (
        select secret
        from session_share_collaboration_test_state
        where name = 'invitation'
      )
    )
  $$,
  $$values ('accepted'::text, 'commenter'::text, true)$$,
  'Accepted invitation inspection returns only the granted share identity'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_other');

select throws_ok(
  $$
    select *
    from founder_hub.delete_session_share_comment(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'commenter_comment'
      )
    )
  $$,
  '42501',
  'session comment operation not permitted',
  'An unrelated user cannot delete another collaborator comment'
);

select tests.clear_authentication();
select tests.authenticate_as('collab_commenter');

select lives_ok(
  $$
    select *
    from founder_hub.delete_session_share_comment(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'commenter_comment'
      )
    )
  $$,
  'A comment author can delete their own comment'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();

select results_eq(
  $$
    select
      body,
      deleted_at is not null,
      deleted_by_user_id = tests.user_id('collab_commenter')
    from founder_hub.session_share_comments
    where id = (
      select entity_id
      from session_share_collaboration_test_state
      where name = 'commenter_comment'
    )
  $$,
  $$values (''::text, true, true)$$,
  'Author deletion redacts the persisted comment body'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('collab_manager');

select lives_ok(
  $$
    select *
    from founder_hub.delete_session_share_comment(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'editor_comment'
      )
    )
  $$,
  'A source workspace manager can moderate a collaborator comment'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();

select results_eq(
  $$
    select
      body,
      deleted_at is not null,
      deleted_by_user_id = tests.user_id('collab_manager')
    from founder_hub.session_share_comments
    where id = (
      select entity_id
      from session_share_collaboration_test_state
      where name = 'editor_comment'
    )
  $$,
  $$values (''::text, true, true)$$,
  'Manager moderation redacts the persisted comment body'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();

select ok(
  not exists (
    select 1
    from founder_hub.session_access_events as event
    join session_share_collaboration_test_state as state
      on state.entity_id = event.related_entity_id
    where state.name in (
        'owner_comment',
        'commenter_comment',
        'editor_comment'
      )
      and (
        event.previous_value = state.body
        or event.new_value = state.body
      )
  ),
  'Collaboration events never persist comment bodies'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('collab_revoked');

select lives_ok(
  $$
    insert into session_share_collaboration_test_state (
      name,
      share_id,
      entity_id
    )
    select
      'revoked_access_request',
      share.share_id,
      request.request_id
    from session_share_collaboration_test_state as share
    cross join lateral founder_hub.request_session_access(
      share.share_id,
      'commenter'
    ) as request
    where share.name = 'share'
  $$,
  'A user with a revoked grant can request Commenter access again'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as_hyprnote_pro('collab_owner');

select lives_ok(
  $$
    insert into session_share_collaboration_test_state (
      name,
      share_id,
      entity_id,
      body
    )
    select
      'revoked_access_grant',
      request.share_id,
      review.grant_id,
      review.capability
    from session_share_collaboration_test_state as request
    cross join lateral founder_hub.review_session_access_request(
      request.entity_id,
      'approved',
      'commenter'
    ) as review
    where request.name = 'revoked_access_request'
  $$,
  'A Pro manager can approve the renewed Commenter request'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('collab_revoked');

select results_eq(
  $$
    select requested_capability, status
    from founder_hub.get_my_session_access_request(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    )
  $$,
  $$values ('commenter'::text, 'approved'::text)$$,
  'An approved request remains visible while its matching grant is active'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as_hyprnote_pro('collab_owner');

select lives_ok(
  $$
    select *
    from founder_hub.revoke_session_access_grant(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'revoked_access_grant'
      )
    )
  $$,
  'A manager can revoke the approved Commenter grant'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('collab_revoked');

select results_eq(
  $$
    select count(*)
    from founder_hub.get_my_session_access_request(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      )
    )
  $$,
  array[0::bigint],
  'A revoked approval no longer traps the requester in approved state'
);

select results_eq(
  $$
    select requested_capability, was_created
    from founder_hub.request_session_access(
      (
        select share_id
        from session_share_collaboration_test_state
        where name = 'share'
      ),
      'commenter'
    )
  $$,
  $$values ('commenter'::text, true)$$,
  'A user can create a fresh request after the approved grant is revoked'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as_service_role();

update founder_hub.workspaces
set deleted_at = now()
where id = (
  select workspace_id
  from session_share_collaboration_test_state
  where name = 'share'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('collab_invitee');

select results_eq(
  $$
    select count(*)
    from founder_hub.inspect_my_session_access_invitation(
      (
        select entity_id
        from session_share_collaboration_test_state
        where name = 'invitation'
      ),
      (
        select secret
        from session_share_collaboration_test_state
        where name = 'invitation'
      )
    )
  $$,
  array[0::bigint],
  'Invitation inspection hides shares whose source workspace is unavailable'
);

select * from finish();
rollback;
