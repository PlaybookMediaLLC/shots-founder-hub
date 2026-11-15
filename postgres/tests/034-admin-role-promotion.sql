begin;
select plan(9);

select tests.create_user('promo_owner', 'promo-owner@example.com');
select tests.create_user('promo_admin', 'promo-admin@example.com');
select tests.create_user('promo_member', 'promo-member@example.com');

create temporary table promo_test_state (
  name text primary key,
  workspace_id uuid,
  invitation_id uuid,
  invite_token text
);

grant all on promo_test_state to cloud_member, cloud_service;

reset role;

update founder_hub_identity.users
set email_confirmed_at = now()
where id in (
  tests.user_id('promo_owner'),
  tests.user_id('promo_admin'),
  tests.user_id('promo_member')
);

select tests.authenticate_as_hyprnote_pro('promo_owner');

insert into promo_test_state (name, workspace_id)
select 'hq', workspace_id from founder_hub.create_workspace('Promotion HQ');

select tests.enable_workspace_plan(
  (select workspace_id from promo_test_state where name = 'hq')
);

-- Seat both teammates.
insert into promo_test_state (name, invitation_id, invite_token)
select 'admin_invite', invitation_id, invite_token
from founder_hub.create_workspace_invitation(
  (select workspace_id from promo_test_state where name = 'hq'),
  'promo-admin@example.com'
);

insert into promo_test_state (name, invitation_id, invite_token)
select 'member_invite', invitation_id, invite_token
from founder_hub.create_workspace_invitation(
  (select workspace_id from promo_test_state where name = 'hq'),
  'promo-member@example.com'
);

select tests.clear_authentication();
select tests.authenticate_as_hyprnote_pro('promo_admin');

select lives_ok(
  $$
    select * from founder_hub.accept_workspace_invitation(
      (select invitation_id from promo_test_state where name = 'admin_invite'),
      (select invite_token from promo_test_state where name = 'admin_invite')
    )
  $$,
  'The future admin joins the workspace'
);

select throws_ok(
  $$
    select * from founder_hub.set_workspace_membership_role(
      (select workspace_id from promo_test_state where name = 'hq'),
      tests.user_id('promo_admin'),
      'admin'
    )
  $$,
  '42501',
  'workspace membership operation not permitted',
  'A plain member cannot promote themselves'
);

select tests.clear_authentication();
select tests.authenticate_as('promo_member');

select lives_ok(
  $$
    select * from founder_hub.accept_workspace_invitation(
      (select invitation_id from promo_test_state where name = 'member_invite'),
      (select invite_token from promo_test_state where name = 'member_invite')
    )
  $$,
  'The plain member joins the workspace'
);

select tests.clear_authentication();
select tests.authenticate_as_hyprnote_pro('promo_owner');

select results_eq(
  $$
    select membership_role
    from founder_hub.set_workspace_membership_role(
      (select workspace_id from promo_test_state where name = 'hq'),
      tests.user_id('promo_admin'),
      'admin'
    )
  $$,
  array['admin'::text],
  'The owner appoints the first admin'
);

select tests.clear_authentication();
select tests.authenticate_as_hyprnote_pro('promo_admin');

select results_eq(
  $$
    select membership_role
    from founder_hub.set_workspace_membership_role(
      (select workspace_id from promo_test_state where name = 'hq'),
      tests.user_id('promo_member'),
      'admin'
    )
  $$,
  array['admin'::text],
  'An admin can raise a member to admin, so the owner is not a bottleneck'
);

select throws_ok(
  $$
    select * from founder_hub.set_workspace_membership_role(
      (select workspace_id from promo_test_state where name = 'hq'),
      tests.user_id('promo_member'),
      'member'
    )
  $$,
  '42501',
  'workspace membership operation not permitted',
  'An admin cannot strip a peer admin back to member'
);

select throws_ok(
  $$
    select * from founder_hub.set_workspace_membership_role(
      (select workspace_id from promo_test_state where name = 'hq'),
      tests.user_id('promo_owner'),
      'member'
    )
  $$,
  '42501',
  'workspace membership operation not permitted',
  'An admin cannot demote the owner'
);

select throws_ok(
  $$
    select * from founder_hub.set_workspace_membership_role(
      (select workspace_id from promo_test_state where name = 'hq'),
      tests.user_id('promo_member'),
      'owner'
    )
  $$,
  '42501',
  'workspace membership operation not permitted',
  'Admins cannot grant ownership through role management'
);

select tests.clear_authentication();
select tests.authenticate_as_hyprnote_pro('promo_owner');

select results_eq(
  $$
    select membership_role
    from founder_hub.set_workspace_membership_role(
      (select workspace_id from promo_test_state where name = 'hq'),
      tests.user_id('promo_member'),
      'member'
    )
  $$,
  array['member'::text],
  'The owner can still demote an admin'
);

select * from finish();
rollback;
