begin;
select plan(9);

select tests.create_user(
  'slug_availability_owner',
  'slug-availability-owner@example.com'
);
select tests.create_user(
  'slug_availability_outsider',
  'slug-availability-outsider@example.com'
);

create temporary table workspace_slug_availability_test_state (
  name text primary key,
  workspace_id uuid not null
);

grant all on workspace_slug_availability_test_state
to cloud_member, cloud_service;

reset role;

update founder_hub_identity.users
set email_confirmed_at = now()
where id in (
  tests.user_id('slug_availability_owner'),
  tests.user_id('slug_availability_outsider')
);

select tests.authenticate_as('slug_availability_owner');

insert into workspace_slug_availability_test_state (name, workspace_id)
select 'candidate', workspace_id
from founder_hub.create_workspace('Candidate workspace');

insert into workspace_slug_availability_test_state (name, workspace_id)
select 'claimed', workspace_id
from founder_hub.create_workspace('Claimed workspace');

insert into workspace_slug_availability_test_state (name, workspace_id)
select 'team', workspace_id
from founder_hub.create_workspace('Team workspace');

select tests.clear_authentication();
reset role;

select tests.enable_workspace_plan(
  (select workspace_id from workspace_slug_availability_test_state where name = 'candidate'),
  'enterprise'
);
select tests.enable_workspace_plan(
  (select workspace_id from workspace_slug_availability_test_state where name = 'claimed'),
  'enterprise'
);
select tests.enable_workspace_plan(
  (select workspace_id from workspace_slug_availability_test_state where name = 'team'),
  'team'
);

select tests.authenticate_as('slug_availability_owner');

select ok(
  has_function_privilege(
    'cloud_member',
    'founder_hub.check_workspace_share_slug_availability(uuid,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'cloud_anonymous',
      'founder_hub.check_workspace_share_slug_availability(uuid,text)',
      'EXECUTE'
    ),
  'Only cloud_member callers can check workspace subdomain availability'
);

select is(
  founder_hub.check_workspace_share_slug_availability(
    (select workspace_id from workspace_slug_availability_test_state where name = 'candidate'),
    'fresh-domain'
  ),
  'available',
  'An unclaimed workspace subdomain is available'
);

select is(
  founder_hub.check_workspace_share_slug_availability(
    (select workspace_id from workspace_slug_availability_test_state where name = 'candidate'),
    'models'
  ),
  'invalid',
  'A reserved platform subdomain is invalid'
);

select is(
  founder_hub.check_workspace_share_slug_availability(
    (select workspace_id from workspace_slug_availability_test_state where name = 'candidate'),
    'no'
  ),
  'invalid',
  'A malformed workspace subdomain is invalid'
);

select lives_ok(
  $$
    select * from founder_hub.set_workspace_share_slug(
      (select workspace_id from workspace_slug_availability_test_state where name = 'claimed'),
      'claimed-domain'
    )
  $$,
  'An Enterprise manager can claim the comparison subdomain'
);

select is(
  founder_hub.check_workspace_share_slug_availability(
    (select workspace_id from workspace_slug_availability_test_state where name = 'candidate'),
    'claimed-domain'
  ),
  'taken',
  'A subdomain claimed by another workspace is taken'
);

select is(
  founder_hub.check_workspace_share_slug_availability(
    (select workspace_id from workspace_slug_availability_test_state where name = 'claimed'),
    'claimed-domain'
  ),
  'available',
  'A workspace can keep its current subdomain'
);

select throws_ok(
  $$
    select founder_hub.check_workspace_share_slug_availability(
      (select workspace_id from workspace_slug_availability_test_state where name = 'team'),
      'team-domain'
    )
  $$,
  '42501',
  'workspace capability required: team.custom_subdomain',
  'Team cannot check Enterprise workspace subdomains'
);

select tests.clear_authentication();
select tests.authenticate_as('slug_availability_outsider');

select throws_ok(
  $$
    select founder_hub.check_workspace_share_slug_availability(
      (select workspace_id from workspace_slug_availability_test_state where name = 'candidate'),
      'fresh-domain'
    )
  $$,
  '42501',
  'workspace subdomain operation not permitted',
  'An unrelated account cannot check an Enterprise workspace subdomain'
);

select * from finish();
rollback;
