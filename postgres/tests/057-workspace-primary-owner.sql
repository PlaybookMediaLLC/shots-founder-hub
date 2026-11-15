begin;
select plan(21);

select tests.create_user('primary', 'primary@example.com');
select tests.create_user('coowner', 'coowner@example.com');
select tests.create_user('peerowner', 'peerowner@example.com');
select tests.create_user('roleadmin', 'roleadmin@example.com');
update founder_hub_identity.users set email_confirmed_at = now()
where id in (tests.user_id('primary'), tests.user_id('coowner'), tests.user_id('peerowner'), tests.user_id('roleadmin'));
create temporary table ownership_state (workspace_id uuid);
grant all on ownership_state to cloud_member;
select tests.authenticate_as_hyprnote_pro('primary');
insert into ownership_state select workspace_id from founder_hub.create_workspace('Owners');
select tests.enable_workspace_plan((select workspace_id from ownership_state));
reset role;
insert into founder_hub.workspace_memberships(workspace_id, user_id, role)
select workspace_id, tests.user_id('coowner'), 'member' from ownership_state
union all select workspace_id, tests.user_id('peerowner'), 'member' from ownership_state
union all select workspace_id, tests.user_id('roleadmin'), 'admin' from ownership_state;
select tests.authenticate_as_hyprnote_pro('primary');
select lives_ok($$select founder_hub.set_workspace_membership_role((select workspace_id from ownership_state), tests.user_id('coowner'), 'owner')$$, 'Primary can appoint another owner');
select is((select owner_user_id from founder_hub.workspaces where id = (select workspace_id from ownership_state)), tests.user_id('primary'), 'Appointing owners does not change the primary');
select throws_ok($$select founder_hub.set_workspace_membership_role((select workspace_id from ownership_state), tests.user_id('primary'), 'member')$$, '42501', 'workspace membership operation not permitted', 'Primary cannot demote themselves even with another owner');
select throws_ok($$select founder_hub.leave_workspace((select workspace_id from ownership_state))$$, '22023', 'owner must transfer ownership before leaving', 'Primary cannot leave even with another owner');

select tests.authenticate_as_hyprnote_pro('coowner');
select lives_ok($$select founder_hub.set_workspace_membership_role((select workspace_id from ownership_state), tests.user_id('peerowner'), 'owner')$$, 'Ordinary owners can appoint owners');
select throws_ok($$select founder_hub.set_workspace_membership_role((select workspace_id from ownership_state), tests.user_id('primary'), 'admin')$$, '42501', 'workspace membership operation not permitted', 'Ordinary owners cannot demote the primary');
select throws_ok($$select founder_hub.set_workspace_membership_role((select workspace_id from ownership_state), tests.user_id('peerowner'), 'admin')$$, '42501', 'workspace membership operation not permitted', 'Ordinary owners cannot strip a peer owner');
select throws_ok($$select founder_hub.revoke_workspace_membership((select workspace_id from ownership_state), tests.user_id('peerowner'))$$, '42501', 'workspace membership operation not permitted', 'Ordinary owners cannot remove a peer owner');
select throws_ok($$select founder_hub.revoke_workspace_membership((select workspace_id from ownership_state), tests.user_id('primary'))$$, '42501', 'workspace membership operation not permitted', 'Primary cannot be removed');
select throws_ok($$select founder_hub.transfer_workspace_ownership((select workspace_id from ownership_state), tests.user_id('peerowner'))$$, '42501', 'workspace ownership operation not permitted', 'Only primary may request a transfer');
select throws_ok($$select founder_hub.delete_workspace((select workspace_id from ownership_state))$$, '42501', 'workspace operation not permitted', 'Only primary may delete the workspace');
select lives_ok($$select founder_hub.set_workspace_membership_role((select workspace_id from ownership_state), tests.user_id('coowner'), 'member')$$, 'Ordinary owner can demote themselves');

select tests.authenticate_as_hyprnote_pro('roleadmin');
select throws_ok($$select founder_hub.set_workspace_membership_role((select workspace_id from ownership_state), tests.user_id('coowner'), 'owner')$$, '42501', 'workspace membership operation not permitted', 'Admin cannot appoint owners');
select tests.authenticate_as_hyprnote_pro('primary');
select lives_ok($$select founder_hub.set_workspace_membership_role((select workspace_id from ownership_state), tests.user_id('coowner'), 'owner')$$, 'Primary can restore an owner');
select lives_ok($$select founder_hub.transfer_workspace_ownership((select workspace_id from ownership_state), tests.user_id('coowner'))$$, 'Primary requests transfer to an existing owner');
select is((select owner_user_id from founder_hub.workspaces where id = (select workspace_id from ownership_state)), tests.user_id('primary'), 'Pending transfer does not change primary');
select tests.authenticate_as_hyprnote_pro('coowner');
select lives_ok($$select founder_hub.respond_workspace_ownership_request((select workspace_id from ownership_state), (select id from founder_hub.list_workspace_ownership_requests((select workspace_id from ownership_state))), 'accept')$$, 'Recipient accepts primary ownership');
select is((select owner_user_id from founder_hub.workspaces where id = (select workspace_id from ownership_state)), tests.user_id('coowner'), 'Acceptance changes the single primary');
select is((select role from founder_hub.list_workspace_members_with_profiles((select workspace_id from ownership_state)) where user_id = tests.user_id('primary')), 'owner', 'Previous primary remains an owner');
select lives_ok($$select founder_hub.revoke_workspace_membership((select workspace_id from ownership_state), tests.user_id('peerowner'))$$, 'Primary can remove an ordinary owner');
select tests.authenticate_as_hyprnote_pro('primary');
select lives_ok($$select founder_hub.leave_workspace((select workspace_id from ownership_state))$$, 'Previous primary can leave after accepted transfer');
select * from finish();
rollback;
