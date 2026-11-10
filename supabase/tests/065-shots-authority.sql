BEGIN;
SELECT plan(59);

INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data, created_at, updated_at)
VALUES ('33333333-3333-4333-8333-333333333333', 'legacy-owner@unrelated.test', now(), '{"provider":"email"}', now(), now());
INSERT INTO stripe.customers (id) VALUES ('cus_shots_legacy_domain');
INSERT INTO public.workspaces (id, owner_user_id, kind, name, stripe_customer_id, seat_limit)
VALUES ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 'shared', 'Legacy domain', 'cus_shots_legacy_domain', 100);
INSERT INTO stripe.subscriptions (id, customer, status) VALUES ('sub_shots_legacy_domain', 'cus_shots_legacy_domain', 'active');
INSERT INTO stripe.active_entitlements (id, customer, lookup_key) VALUES ('ent_shots_legacy_domain', 'cus_shots_legacy_domain', 'hyprnote_enterprise');
INSERT INTO public.workspace_verified_domains (workspace_id, domain) VALUES ('44444444-4444-4444-8444-444444444444', 'example.test');
INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data, created_at, updated_at)
VALUES ('88888888-8888-4888-8888-888888888888', 'legacy-user@example.test', now(), '{"provider":"email"}', now(), now());
SELECT is((SELECT count(*) FROM public.workspace_memberships WHERE workspace_id='44444444-4444-4444-8444-444444444444' AND user_id='88888888-8888-4888-8888-888888888888'), 1::bigint, 'Legacy domain capture still works for legacy accounts');

CREATE TEMP TABLE shots_fixture (snapshot jsonb);
INSERT INTO shots_fixture
SELECT jsonb_build_object(
  'revision', '1', 'accountUserId', 'a3ab7abe-0592-4d51-872b-40127ebfa731',
  'createdAt', now(), 'emailVerified', true, 'sessionId', 'shots-test-session', 'expiresAt', now() + interval '1 hour',
  'user', jsonb_build_object('id', 'shots-test-creator', 'email', 'shots-creator@example.test', 'name', 'Creator', 'image', NULL),
  'workspaces', jsonb_build_array(jsonb_build_object(
    'organizationId', 'shots-test-team', 'workspaceId', 'bd823bc2-1882-43ae-b5b4-f7e117a3a667',
    'ownerUserId', 'aa6bd44e-d538-42e1-89ed-24a81ebead85', 'name', 'Shots team',
    'features', jsonb_build_object('workspace:paid', true),
    'owner', owner, 'members', jsonb_build_array(owner, creator)
  ))
)
FROM (SELECT
  jsonb_build_object('accountUserId', 'aa6bd44e-d538-42e1-89ed-24a81ebead85', 'createdAt', now(), 'emailVerified', true,
    'user', jsonb_build_object('id', 'shots-test-owner', 'email', 'shots-owner@example.test', 'name', 'Owner', 'image', NULL),
    'role', 'owner', 'permissions', jsonb_build_array('workspace:read', 'artifact:read', 'artifact:edit')) AS owner,
  jsonb_build_object('accountUserId', 'a3ab7abe-0592-4d51-872b-40127ebfa731', 'createdAt', now(), 'emailVerified', true,
    'user', jsonb_build_object('id', 'shots-test-creator', 'email', 'shots-creator@example.test', 'name', 'Creator', 'image', NULL),
    'role', 'creator', 'permissions', jsonb_build_array('workspace:read', 'artifact:read', 'artifact:edit')) AS creator
) identities;

SELECT ok(NOT has_function_privilege('authenticated', 'public.project_shots_authority(jsonb)', 'EXECUTE'), 'Only the service can project Shots authority');
SELECT public.project_shots_authority(snapshot) FROM shots_fixture;
SELECT public.project_shots_authority(snapshot) FROM shots_fixture;
SELECT is((SELECT count(*) FROM private.shots_accounts WHERE shots_user_id LIKE 'shots-test-%'), 2::bigint, 'Projection is idempotent');
SELECT is((SELECT count(*) FROM public.workspace_memberships AS membership JOIN private.shots_accounts AS account ON account.user_id=membership.user_id WHERE membership.workspace_id='44444444-4444-4444-8444-444444444444'), 0::bigint, 'Shots roster emails never acquire legacy domain memberships');
SELECT ok(NOT EXISTS (SELECT 1 FROM private.account_onboarding_outbox AS event JOIN private.shots_accounts AS account ON account.user_id=event.user_id WHERE account.shots_user_id LIKE 'shots-test-%')
  AND NOT EXISTS (SELECT 1 FROM private.account_analytics_outbox AS event JOIN private.shots_accounts AS account ON account.user_id=event.user_id WHERE account.shots_user_id LIKE 'shots-test-%'), 'Projected teammates receive no legacy onboarding or account analytics');
SELECT * FROM public.reconcile_account_analytics_events();
SELECT is((SELECT count(*) FROM private.account_analytics_outbox AS event JOIN private.shots_accounts AS account ON account.user_id=event.user_id WHERE account.shots_user_id LIKE 'shots-test-%'), 0::bigint, 'Analytics reconciliation also excludes projected accounts');

SELECT is((SELECT owner_user_id FROM public.workspaces WHERE id = 'bd823bc2-1882-43ae-b5b4-f7e117a3a667'),
  'aa6bd44e-d538-42e1-89ed-24a81ebead85'::uuid, 'A creator signing in first does not become owner');
SELECT is((SELECT stripe_customer_id FROM public.profiles WHERE id = 'a3ab7abe-0592-4d51-872b-40127ebfa731'), NULL::text, 'Shots creates no legacy billing link');

SELECT ok(NOT has_function_privilege('authenticated', 'public.create_shots_cloud_api_key(uuid,uuid,text,text,text,text,text)', 'EXECUTE'), 'Only the service can bind an API key to a Shots session');
SELECT ok(private.cloud_api_user_has_pro('a3ab7abe-0592-4d51-872b-40127ebfa731'), 'Cloud API uses current Shots entitlement without Stripe');
SELECT * FROM public.set_cloud_api_enabled('a3ab7abe-0592-4d51-872b-40127ebfa731', true);
SELECT lives_ok($$SELECT * FROM public.create_shots_cloud_api_key('a3ab7abe-0592-4d51-872b-40127ebfa731',
  '55555555-5555-4555-8555-555555555555', 'Connector', repeat('b',64), 'anl_bbbbbbbb', 'shots-test-creator', 'shots-test-session')$$,
  'A central account can create a session-bound key');
SELECT is((SELECT shots_session_id FROM public.lookup_shots_cloud_api_key(repeat('b',64))), 'shots-test-session', 'Key lookup preserves the verified session binding');
SELECT is((SELECT count(*) FROM public.verify_cloud_api_key(repeat('b',64))), 0::bigint, 'Legacy verification cannot bypass the live Shots authority check');
SELECT * FROM public.create_cloud_api_key('a3ab7abe-0592-4d51-872b-40127ebfa731', '66666666-6666-4666-8666-666666666666',
  'Legacy', repeat('c',64), 'anl_cccccccc');
SELECT is((SELECT count(*) FROM public.lookup_shots_cloud_api_key(repeat('c',64))), 0::bigint, 'Unbound legacy keys cannot authorize central requests');
SELECT throws_ok($$SELECT * FROM public.create_shots_cloud_api_key('a3ab7abe-0592-4d51-872b-40127ebfa731',
  '77777777-7777-4777-8777-777777777777', 'Wrong identity', repeat('d',64), 'anl_dddddddd', 'shots-test-owner', 'shots-test-session')$$,
  '42501', 'Shots identity mismatch', 'Key binding cannot substitute another Shots identity');

SELECT lives_ok($$
  SELECT * FROM public.publish_shots_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-team',
    '{"id":"shots-cloud-team","title":"Team","started_at":"2026-11-09","transcripts":[]}', 'bd823bc2-1882-43ae-b5b4-f7e117a3a667');
  SELECT * FROM public.publish_shots_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-personal',
    '{"id":"shots-cloud-personal","title":"Personal","started_at":"2026-11-08","transcripts":[]}', 'a3ab7abe-0592-4d51-872b-40127ebfa731');
$$, 'Native snapshot publication binds team and personal provenance');
SELECT * FROM public.publish_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-old',
  '{"id":"shots-cloud-old","title":"Unproven","started_at":"2026-11-10","transcripts":[]}');
SELECT is((SELECT count(*) FROM public.read_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-old')),
  0::bigint, 'Legacy snapshots remain hidden until republished with provenance');
SELECT lives_ok($$
  SELECT * FROM public.publish_shots_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-team',
    '{"id":"shots-cloud-team","title":"Team","started_at":"2026-11-09","transcripts":[]}', 'a3ab7abe-0592-4d51-872b-40127ebfa731');
  SELECT * FROM public.publish_shots_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-team',
    '{"id":"shots-cloud-team","title":"Team","started_at":"2026-11-09","transcripts":[]}', 'bd823bc2-1882-43ae-b5b4-f7e117a3a667');
$$, 'Moving a published note works with source read and destination edit permission');

SELECT set_config('request.jwt.claims', '{"sub":"aa6bd44e-d538-42e1-89ed-24a81ebead85","role":"authenticated","shots_revision":"1","shots_session_id":"owner-session"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT * FROM public.list_workspace_key_recipients('bd823bc2-1882-43ae-b5b4-f7e117a3a667')$$,
  '42501', 'Shots workspace permission required', 'Owner role cannot bypass denied member disclosure');
SELECT throws_ok($$SELECT * FROM public.set_workspace_e2ee_key('bd823bc2-1882-43ae-b5b4-f7e117a3a667', repeat('K', 22), '[]'::jsonb)$$,
  '42501', 'Shots workspace permission required', 'Owner role cannot bypass denied identity administration');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
INSERT INTO public.session_shares (id, workspace_id, session_id, created_by_user_id, general_scope, general_workspace_id)
VALUES ('11111111-1111-4111-8111-111111111111', 'a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-private-note',
  'a3ab7abe-0592-4d51-872b-40127ebfa731', 'workspace', 'bd823bc2-1882-43ae-b5b4-f7e117a3a667');
CREATE TEMP TABLE shots_share_version AS SELECT access_version FROM public.session_shares WHERE id='11111111-1111-4111-8111-111111111111';
SELECT public.project_shots_authority(snapshot) FROM shots_fixture;
SELECT is((SELECT access_version FROM public.session_shares WHERE id='11111111-1111-4111-8111-111111111111'), (SELECT access_version FROM shots_share_version), 'Repeated authentication preserves outstanding share access versions');

CREATE TEMP TABLE shots_attachment_fixture AS
SELECT * FROM public.reserve_session_share_attachment('11111111-1111-4111-8111-111111111111',
  'a3ab7abe-0592-4d51-872b-40127ebfa731', repeat('A', 43), repeat('B', 43), 'note.png', 'image/png', 1024);
UPDATE public.session_share_attachment_objects SET state = 'ready', finalized_at = now(), sha256 = repeat('a', 64)
WHERE id = (SELECT attachment_id FROM shots_attachment_fixture);
INSERT INTO public.session_share_snapshots (share_id, published_by_user_id, web_editable)
VALUES ('11111111-1111-4111-8111-111111111111', 'a3ab7abe-0592-4d51-872b-40127ebfa731', true);
INSERT INTO public.session_share_snapshot_attachments (share_id, attachment_id, position)
SELECT '11111111-1111-4111-8111-111111111111', attachment_id, 0 FROM shots_attachment_fixture;
SELECT is((SELECT count(*) FROM public.prepare_my_session_share_attachment_download('11111111-1111-4111-8111-111111111111',
  (SELECT attachment_id FROM shots_attachment_fixture), 'a3ab7abe-0592-4d51-872b-40127ebfa731', clock_timestamp() + interval '60 seconds')),
  1::bigint, 'Central read permission allows a published attachment download');

INSERT INTO public.workspace_e2ee_keys (workspace_id, key_id)
VALUES ('bd823bc2-1882-43ae-b5b4-f7e117a3a667', repeat('K', 22));
INSERT INTO public.workspace_e2ee_key_grants (workspace_id, key_id, member_user_id, ephemeral_public_key, nonce, ciphertext)
VALUES ('bd823bc2-1882-43ae-b5b4-f7e117a3a667', repeat('K', 22), 'a3ab7abe-0592-4d51-872b-40127ebfa731', repeat('E', 43), repeat('N', 32), repeat('C', 64));

SELECT set_config('request.jwt.claims', '{"sub":"a3ab7abe-0592-4d51-872b-40127ebfa731","role":"authenticated","shots_revision":"1","shots_session_id":"shots-test-session","entitlements":["hyprnote_pro"]}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*) FROM public.list_all_my_workspace_e2ee_grants()), 1::bigint, 'Read permission exposes bulk encryption grants');
SELECT is((SELECT count(*) FROM public.list_my_workspace_e2ee_grants('bd823bc2-1882-43ae-b5b4-f7e117a3a667')), 1::bigint, 'Read permission exposes per-workspace encryption grants');
SELECT ok(private.shots_allows(auth.uid(), 'bd823bc2-1882-43ae-b5b4-f7e117a3a667', 'artifact:edit'), 'Creator has central edit permission');
SELECT lives_ok($$SELECT public.upsert_shared_resource('folder', 'shots-test-folder', 'Folder', '{}'::jsonb, 'bd823bc2-1882-43ae-b5b4-f7e117a3a667')$$, 'Creator can save a shared resource');
SELECT is((SELECT capability FROM public.read_my_session_share_snapshot_v2('11111111-1111-4111-8111-111111111111')), 'editor', 'Creator can read and edit their published note');
SELECT lives_ok($$SELECT * FROM public.create_session_share_comment('11111111-1111-4111-8111-111111111111', 'Private comment')$$, 'Creator can comment on the published note');
SELECT ok(NOT private.shots_allows(auth.uid(), '86a521f0-fe6c-4692-b324-4d85110efc69', 'workspace:read'), 'Foreign workspace is denied');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

UPDATE shots_fixture SET snapshot = jsonb_set(jsonb_set(jsonb_set(snapshot,
  '{revision}', '"2"'), '{workspaces,0,members,1,role}', '"viewer"'),
  '{workspaces,0,members,1,permissions}', '["workspace:read","artifact:read"]');
SELECT public.project_shots_authority(snapshot) FROM shots_fixture;
SELECT throws_ok($$SELECT public.project_shots_authority(jsonb_set(snapshot, '{revision}', '"1"')) FROM shots_fixture$$,
  '40001', 'Stale Shots authority', 'Older snapshots cannot restore access');
SELECT set_config('request.jwt.claims', '{"sub":"a3ab7abe-0592-4d51-872b-40127ebfa731","role":"authenticated","shots_revision":"1","shots_session_id":"shots-test-session"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT private.shots_allows(auth.uid(), 'bd823bc2-1882-43ae-b5b4-f7e117a3a667', 'artifact:edit')$$,
  '40001', 'Stale Shots authority', 'In-flight internal credentials cannot use an older snapshot');
SELECT set_config('request.jwt.claims', '{"sub":"a3ab7abe-0592-4d51-872b-40127ebfa731","role":"authenticated","shots_revision":"2","shots_session_id":"shots-test-session","entitlements":["hyprnote_pro"]}', true);
SELECT ok(private.shots_allows(auth.uid(), 'bd823bc2-1882-43ae-b5b4-f7e117a3a667', 'artifact:read'), 'Viewer retains read access');
SELECT is((SELECT capability || ':' || manage_access FROM public.read_my_session_share_snapshot_v2('11111111-1111-4111-8111-111111111111')), 'viewer:false', 'Downgraded source owner retains reading without editor or management capability');
SELECT is((SELECT count(*) FROM public.list_session_share_comments('11111111-1111-4111-8111-111111111111')), 1::bigint, 'Downgraded source owner retains access to their comments');
SELECT is((SELECT count(*) FROM public.list_shared_resources('folder')), 1::bigint, 'Viewer can read the shared resource');
SELECT throws_ok($$SELECT public.upsert_shared_resource('folder', 'shots-test-folder', 'Changed', '{}'::jsonb, 'bd823bc2-1882-43ae-b5b4-f7e117a3a667')$$,
  '42501', 'Shots workspace permission required', 'A downgraded creator cannot edit their old shared resource');
SELECT set_config('request.jwt.claims', '{"sub":"a3ab7abe-0592-4d51-872b-40127ebfa731","role":"authenticated"}', true);
SELECT ok(NOT private.shots_allows(auth.uid(), auth.uid(), 'workspace:read'), 'Legacy Supabase credentials cannot impersonate a Shots account');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT throws_ok($$SELECT * FROM public.reserve_session_share_attachment('11111111-1111-4111-8111-111111111111',
  'a3ab7abe-0592-4d51-872b-40127ebfa731', repeat('C', 43), repeat('D', 43), 'changed.png', 'image/png', 1024)$$,
  '42501', 'Shots workspace permission required', 'Source ownership cannot bypass revoked target workspace edit permission');
UPDATE shots_fixture SET snapshot = jsonb_set(jsonb_set(snapshot, '{revision}', '"3"'),
  '{workspaces,0,members,1,permissions}', '["workspace:read"]');
SELECT public.project_shots_authority(snapshot) FROM shots_fixture;
SELECT is((SELECT count(*) FROM public.read_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-team')),
  0::bigint, 'Permission removal hides previously published team snapshots');
SELECT is((SELECT content_json->>'id' FROM public.list_cloud_api_snapshots('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud', NULL, 1, 0)),
  'shots-cloud-personal', 'Permission filtering happens before pagination');
SELECT throws_ok($$SELECT * FROM public.publish_shots_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-team',
  '{"id":"shots-cloud-team","transcripts":[]}', 'a3ab7abe-0592-4d51-872b-40127ebfa731')$$,
  '42501', 'Shots snapshot permission required', 'A denied team snapshot cannot be relabeled personal');
SELECT public.delete_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-team');
SELECT throws_ok($$SELECT * FROM public.publish_shots_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-team',
  '{"id":"shots-cloud-team","transcripts":[]}', 'a3ab7abe-0592-4d51-872b-40127ebfa731')$$,
  '42501', 'Shots snapshot permission required', 'Deleting content cannot erase its permission boundary');
SELECT is((SELECT count(*) FROM public.read_cloud_api_snapshot('a3ab7abe-0592-4d51-872b-40127ebfa731', 'shots-cloud-personal')),
  1::bigint, 'Losing team read access preserves personal snapshots');
SELECT is((SELECT count(*) FROM public.prepare_my_session_share_attachment_download('11111111-1111-4111-8111-111111111111',
  (SELECT attachment_id FROM shots_attachment_fixture), 'a3ab7abe-0592-4d51-872b-40127ebfa731', clock_timestamp() + interval '60 seconds')),
  0::bigint, 'Revoked artifact read permission prevents a fresh attachment download');
SELECT set_config('request.jwt.claims', '{"sub":"a3ab7abe-0592-4d51-872b-40127ebfa731","role":"authenticated","shots_revision":"3","shots_session_id":"shots-test-session"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*) FROM public.list_all_my_workspace_e2ee_grants()), 0::bigint, 'Denied artifact read hides bulk encryption grants');
SELECT is((SELECT count(*) FROM public.list_my_workspace_e2ee_grants('bd823bc2-1882-43ae-b5b4-f7e117a3a667')), 0::bigint, 'Denied artifact read hides per-workspace encryption grants');
SELECT is((SELECT count(*) FROM public.read_my_session_share_snapshot_v2('11111111-1111-4111-8111-111111111111')), 0::bigint, 'Denied read permission hides the snapshot body');
SELECT is((SELECT count(*) FROM public.list_my_accessible_sessions()), 0::bigint, 'Denied read permission hides the session from its listing');
SELECT is((SELECT count(*) FROM public.list_shared_resources('folder')), 0::bigint, 'Denied read permission hides the resource payload');
SELECT throws_ok($$SELECT * FROM public.list_session_share_comments('11111111-1111-4111-8111-111111111111')$$,
  '42501', 'session comment operation not permitted', 'Denied read permission hides comment bodies and anchors');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE shots_fixture SET snapshot = jsonb_set(jsonb_set(snapshot, '{revision}', '"4"'),
  '{workspaces,0,members,1,permissions}', '[]');
SELECT public.project_shots_authority(snapshot) FROM shots_fixture;
SELECT is((SELECT status FROM public.verify_shots_cloud_api_key(repeat('b',64))), 'subscription_required', 'Revoked workspace access removes inherited Cloud API entitlement');
SELECT public.revoke_cloud_api_key('a3ab7abe-0592-4d51-872b-40127ebfa731', '55555555-5555-4555-8555-555555555555');
SELECT is((SELECT count(*) FROM public.lookup_shots_cloud_api_key(repeat('b',64))), 0::bigint, 'A revoked key cannot resolve its Shots binding');
SELECT is((SELECT cardinality(permissions) FROM private.shots_memberships
  WHERE user_id = 'a3ab7abe-0592-4d51-872b-40127ebfa731' AND workspace_id = 'bd823bc2-1882-43ae-b5b4-f7e117a3a667'),
  0, 'Private authority preserves explicit denials instead of treating them as guests');
SELECT is((SELECT count(*) FROM public.workspace_memberships WHERE user_id = 'a3ab7abe-0592-4d51-872b-40127ebfa731'
  AND workspace_id = 'bd823bc2-1882-43ae-b5b4-f7e117a3a667' AND deleted_at IS NULL), 0::bigint, 'Denied workspace is absent from active legacy memberships');
UPDATE shots_fixture SET snapshot = jsonb_set(jsonb_set(snapshot, '{revision}', '"5"'), '{workspaces}', '[]');
SELECT public.project_shots_authority(snapshot) FROM shots_fixture;
SELECT is((SELECT count(*) FROM private.shots_memberships WHERE user_id = 'a3ab7abe-0592-4d51-872b-40127ebfa731'
  AND workspace_id = 'bd823bc2-1882-43ae-b5b4-f7e117a3a667'), 0::bigint, 'Removed memberships are distinct from explicit permission denials');
SELECT is((SELECT count(*) FROM public.workspace_memberships WHERE user_id = 'a3ab7abe-0592-4d51-872b-40127ebfa731'
  AND workspace_id = 'bd823bc2-1882-43ae-b5b4-f7e117a3a667' AND deleted_at IS NULL), 0::bigint, 'Removed membership is deactivated');
SELECT is((SELECT title FROM public.shared_resources WHERE source_id = 'shots-test-folder'), 'Folder', 'Denied writes preserve existing content');

SELECT public.project_shots_authority(jsonb_build_object(
  'revision', '6', 'accountUserId', '22222222-2222-4222-8222-222222222222', 'createdAt', now(), 'emailVerified', true,
  'sessionId', 'guest-session', 'expiresAt', now() + interval '1 hour', 'workspaces', '[]'::jsonb,
  'user', jsonb_build_object('id', 'shots-test-guest', 'email', 'shots-guest@example.test', 'name', 'Guest', 'image', NULL)));
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","shots_revision":"6","shots_session_id":"guest-session"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*) FROM public.read_my_session_share_snapshot_v2('11111111-1111-4111-8111-111111111111')), 0::bigint, 'An outside Shots account gains no access without a share grant');
RESET ROLE;
INSERT INTO public.session_access_grants (share_id, grantee_user_id, capability)
VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'editor');
SET LOCAL ROLE authenticated;
SELECT is((SELECT capability FROM public.read_my_session_share_snapshot_v2('11111111-1111-4111-8111-111111111111')), 'editor', 'An explicit outside guest retains the granted capability without becoming a workspace member');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
