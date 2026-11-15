begin;
select plan(7);

select tests.create_user('owner', 'owner@example.com');
select tests.create_user('other', 'other@example.com');

select tests.authenticate_as('owner');

select results_eq(
  $$select count(*) from profiles where id = founder_hub_identity.user_id()$$,
  array[1::bigint],
  'Owner can view own profile (auto-created by trigger)'
);

select ok(
  not has_table_privilege('cloud_member', 'founder_hub.profiles', 'INSERT')
    and not has_table_privilege('cloud_member', 'founder_hub.profiles', 'UPDATE')
    and not has_table_privilege('cloud_member', 'founder_hub.profiles', 'DELETE'),
  'Authenticated users cannot mutate server-owned billing profiles'
);

select throws_ok(
  $$update profiles set stripe_customer_id = 'cus_forged' where id = founder_hub_identity.user_id()$$,
  '42501',
  'permission denied for table profiles',
  'An owner cannot forge a Stripe customer mapping'
);

select tests.clear_authentication();
select tests.authenticate_as('other');

select results_eq(
  $$select count(*) from profiles where id = tests.user_id('owner')$$,
  array[0::bigint],
  'Other user cannot view owner profile'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();

select lives_ok(
  $$update profiles set stripe_customer_id = 'cus_service_owned' where id = tests.user_id('owner')$$,
  'Service code can update a billing profile'
);

select ok(
  exists (
    select 1
    from pg_index
    where indexrelid = 'founder_hub.profiles_stripe_customer_id_unique'::regclass
      and indisunique
      and indpred is not null
  ),
  'Stripe customer ownership is unique across non-null profile mappings'
);

select results_eq(
  $$select count(*) from profiles where id in (tests.user_id('owner'), tests.user_id('other'))$$,
  array[2::bigint],
  'Service role can view all test profiles'
);

select * from finish();
rollback;
