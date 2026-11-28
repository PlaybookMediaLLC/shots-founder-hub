begin;
select no_plan();

select tests.create_user('join_owner', 'owner@Auto-Join-Company.test');
select tests.create_user('join_existing', 'existing@auto-join-company.test');
select tests.create_user('join_unverified', 'unverified@auto-join-company.test');
select tests.create_user('join_full', 'full@auto-join-company.test');
select tests.create_user('join_invited', 'invited@auto-join-company.test');
select tests.create_user('join_outside', 'outside@other-company.test');
select tests.create_user('join_subdomain', 'person@sub.auto-join-company.test');
select tests.create_user('join_lookalike', 'person@auto-join-company.test.evil.test');
select tests.create_user('join_later', 'later@auto-join-company.test');

update founder_hub_identity.users set email_confirmed_at = now()
where id in (
  tests.user_id('join_owner'), tests.user_id('join_existing'),
  tests.user_id('join_full'), tests.user_id('join_invited'),
  tests.user_id('join_outside'), tests.user_id('join_subdomain'),
  tests.user_id('join_lookalike'), tests.user_id('join_later')
);
update founder_hub_identity.users set email_confirmed_at = null
where id = tests.user_id('join_unverified');

create temporary table email_join_state (name text primary key, workspace_id uuid);
grant all on email_join_state to cloud_member;
select tests.authenticate_as('join_owner');
insert into email_join_state
select 'main', workspace_id from founder_hub.create_workspace('Email join team');
select results_eq(
  $$ select domain, enabled from founder_hub.get_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main')) $$,
  $$ values ('auto-join-company.test'::text, false) $$,
  'Auto-join is off by default and uses the verified owner email domain'
);
select throws_ok(
  $$ select founder_hub.set_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main'), true) $$,
  '42501', 'workspace capability required: team.manage_members',
  'An unpaid workspace cannot enable team auto-join'
);
reset role;
select tests.enable_workspace_plan((select workspace_id from email_join_state where name = 'main'), 'team', 3);
select tests.authenticate_as('join_owner');
select lives_ok(
  $$ select founder_hub.set_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main'), true) $$,
  'The owner of a Team workspace can enable auto-join without Enterprise'
);
select lives_ok(
  $$ select founder_hub.set_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main'), true) $$,
  'Enabling auto-join twice is idempotent'
);
reset role;

select ok(not has_table_privilege('cloud_member', 'founder_hub.workspace_email_auto_join', 'INSERT'), 'Clients cannot insert arbitrary domains');
select ok(not has_function_privilege('cloud_anonymous', 'founder_hub.set_workspace_email_auto_join(uuid,boolean)', 'EXECUTE'), 'Anonymous callers cannot change auto-join');
select ok(not has_function_privilege('cloud_member', 'founder_hub_private.email_auto_join_domain(uuid)', 'EXECUTE'), 'Clients cannot inspect other users email domains');

update founder_hub_identity.users set last_sign_in_at = now() where id = tests.user_id('join_existing');
select results_eq(
  $$ select role from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_existing') $$,
  array['member'::text], 'An existing verified account joins as a member on sign-in'
);
update founder_hub_identity.users set last_sign_in_at = now() where id = tests.user_id('join_unverified');
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_unverified')), 0::bigint, 'An unverified account cannot join');
update founder_hub_identity.users set email_confirmed_at = now() where id = tests.user_id('join_unverified');
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_unverified')), 1::bigint, 'Confirming email completes automatic joining');
select lives_ok(
  $$ update founder_hub_identity.users set last_sign_in_at = now() where id = tests.user_id('join_full') $$,
  'A full team never blocks sign-in'
);
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_full')), 1::bigint, 'Automatic joining can exceed the previously purchased quantity');
update founder_hub.workspaces set seat_limit = 4 where id = (select workspace_id from email_join_state where name = 'main');
update founder_hub_identity.users set last_sign_in_at = now() where id = tests.user_id('join_full');
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_full')), 1::bigint, 'Repeated sign-in does not create a duplicate membership');

update founder_hub.workspaces set seat_limit = 5 where id = (select workspace_id from email_join_state where name = 'main');
select tests.authenticate_as('join_owner');
select * from founder_hub.create_workspace_invitation((select workspace_id from email_join_state where name = 'main'), 'invited@auto-join-company.test');
reset role;
select lives_ok(
  $$ update founder_hub_identity.users set last_sign_in_at = now() where id = tests.user_id('join_invited') $$,
  'A pending invitation is accepted during automatic joining'
);
select is((select used_seats from founder_hub_private.workspace_seat_usage((select workspace_id from email_join_state where name = 'main'))), 5, 'An invited auto-joiner takes exactly one seat');
select ok((select accepted_at is not null from founder_hub.workspace_invitations where workspace_id = (select workspace_id from email_join_state where name = 'main') and invitee_email = 'invited@auto-join-company.test'), 'The pending invitation is marked accepted');

update founder_hub.workspaces set seat_limit = 20 where id = (select workspace_id from email_join_state where name = 'main');
update founder_hub_identity.users set last_sign_in_at = now() where id in (tests.user_id('join_outside'), tests.user_id('join_subdomain'), tests.user_id('join_lookalike'));
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id in (tests.user_id('join_outside'), tests.user_id('join_subdomain'), tests.user_id('join_lookalike'))), 0::bigint, 'Only the exact company domain matches');

update founder_hub.workspace_memberships set role = 'admin' where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_existing');
select tests.authenticate_as('join_existing');
select throws_ok(
  $$ select founder_hub.set_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main'), false) $$,
  '42501', 'only the workspace owner can configure email auto-join', 'An admin cannot change the owner setting'
);
select throws_ok(
  $$ select * from founder_hub.get_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main')) $$,
  '42501', 'only the workspace owner can configure email auto-join', 'An admin cannot read the owner setting'
);
reset role;
update founder_hub_identity.users set last_sign_in_at = now() where id = tests.user_id('join_existing');
select is((select role from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_existing')), 'admin', 'Repeated sign-in preserves existing roles');
update founder_hub.workspace_memberships set deleted_at = now() where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_existing');
update founder_hub_identity.users set last_sign_in_at = now() where id = tests.user_id('join_existing');
select ok((select deleted_at is not null from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_existing')), 'Removed members are not automatically reinstated');

select tests.authenticate_as('join_owner');
insert into email_join_state select 'duplicate', workspace_id from founder_hub.create_workspace('Second team');
reset role;
select tests.enable_workspace_plan((select workspace_id from email_join_state where name = 'duplicate'));
select tests.authenticate_as('join_owner');
select throws_ok(
  $$ select founder_hub.set_workspace_email_auto_join((select workspace_id from email_join_state where name = 'duplicate'), true) $$,
  '22023', 'email domain is already used by another workspace', 'One company domain cannot automatically join multiple teams'
);
select founder_hub.set_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main'), false);
reset role;
update founder_hub_identity.users set last_sign_in_at = now() where id = tests.user_id('join_later');
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_later')), 0::bigint, 'Disabling stops future automatic joins');
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and deleted_at is null), 4::bigint, 'Disabling preserves existing members');

select tests.authenticate_as('join_owner');
select founder_hub.set_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main'), true);
reset role;
update founder_hub_identity.users set is_anonymous = true where id = tests.user_id('join_later');
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_later')), 0::bigint, 'Anonymous accounts cannot join even with a confirmed-looking email');
update founder_hub_identity.users set is_anonymous = false where id = tests.user_id('join_later');
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_later')), 1::bigint, 'A converted verified account can join');

update founder_hub_identity.users set email = 'owner@gmail.com' where id = tests.user_id('join_owner');
select is((select count(*) from founder_hub.workspace_email_auto_join where workspace_id = (select workspace_id from email_join_state where name = 'main')), 0::bigint, 'Changing the owner email disables the old domain');
select tests.authenticate_as('join_owner');
select throws_ok(
  $$ select founder_hub.set_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main'), true) $$,
  '22023', 'a verified work email is required for email auto-join', 'Personal-email owners cannot enable auto-join'
);
reset role;

do $$
declare v_domain text;
begin
  foreach v_domain in array array['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.co.uk', 'yahoo.co.jp', 'icloud.com', 'privaterelay.appleid.com', 'proton.me', 'pm.me', 'fastmail.com', 'person.fastmail.com', 'hey.com', 'mail.com', 'qq.com', 'naver.com', 'duck.com', 'mozmail.com', 'mailinator.com'] loop
    update founder_hub_identity.users set email = 'owner@' || v_domain where id = tests.user_id('join_owner');
    if founder_hub_private.email_auto_join_domain(tests.user_id('join_owner')) is not null then
      raise exception 'Public domain was accepted: %', v_domain;
    end if;
  end loop;
end;
$$;
select pass('Common public, regional, relay, alias, and disposable domains are excluded');

update founder_hub_identity.users set email = 'owner@auto-join-company.test' where id = tests.user_id('join_owner');
select tests.authenticate_as('join_owner');
select founder_hub.set_workspace_email_auto_join((select workspace_id from email_join_state where name = 'main'), true);
reset role;
select tests.create_user('join_new', 'new@auto-join-company.test');
update founder_hub_identity.users set email_confirmed_at = now() where id = tests.user_id('join_new');
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_new')), 1::bigint, 'A new signup joins after its email is verified');

delete from stripe.active_entitlements
where customer = (select stripe_customer_id from founder_hub.workspaces where id = (select workspace_id from email_join_state where name = 'main'));
select tests.create_user('join_unpaid', 'unpaid@auto-join-company.test');
update founder_hub_identity.users set email_confirmed_at = now(), last_sign_in_at = now() where id = tests.user_id('join_unpaid');
select is((select count(*) from founder_hub.workspace_memberships where workspace_id = (select workspace_id from email_join_state where name = 'main') and user_id = tests.user_id('join_unpaid')), 0::bigint, 'A downgraded workspace stops automatically adding members');
select tests.enable_workspace_plan((select workspace_id from email_join_state where name = 'main'), 'team', 20);

update founder_hub.workspaces set owner_user_id = tests.user_id('join_full') where id = (select workspace_id from email_join_state where name = 'main');
select is((select count(*) from founder_hub.workspace_email_auto_join where workspace_id = (select workspace_id from email_join_state where name = 'main')), 0::bigint, 'Ownership transfer requires the new owner to opt in again');

select * from finish();
rollback;
