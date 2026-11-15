begin;
select plan(29);

select tests.create_user('trial_new', 'trial-new@example.com');
select tests.create_user('trial_customer_only', 'trial-customer-only@example.com');
select tests.create_user('trial_active', 'trial-active@example.com');
select tests.create_user('trial_email_alias', 'j.doe+x@googlemail.com');
select tests.create_user('trial_repeat', 'trial-repeat@example.com');
select tests.create_user('trial_former_paid', 'trial-former-paid@example.com');
select tests.create_user('trial_missing_profile', 'trial-missing-profile@example.com');
select tests.create_user('trial_deleting', 'trial-deleting@example.com');

create temporary table pro_trial_reservation_test_state (
  reservation_id uuid primary key,
  reserved_until timestamptz not null
);

grant all on pro_trial_reservation_test_state to cloud_member, cloud_service;

insert into founder_hub_identity.users (
  id,
  raw_user_meta_data,
  raw_app_meta_data,
  is_anonymous,
  created_at,
  updated_at
)
values (
  '00000000-0000-4000-8000-000000001630'::uuid,
  jsonb_build_object('test_identifier', 'trial_anonymous'),
  '{}'::jsonb,
  true,
  now(),
  now()
);

update founder_hub.profiles
set stripe_customer_id = case id
  when tests.user_id('trial_customer_only') then 'cus_trial_customer_only'
  when tests.user_id('trial_active') then 'cus_trial_active'
  when tests.user_id('trial_repeat') then 'cus_trial_repeat'
  when tests.user_id('trial_former_paid') then 'cus_trial_former_paid'
end
where id in (
  tests.user_id('trial_customer_only'),
  tests.user_id('trial_active'),
  tests.user_id('trial_repeat'),
  tests.user_id('trial_former_paid')
);

insert into stripe.customers (id)
values
  ('cus_trial_customer_only'),
  ('cus_trial_active'),
  ('cus_trial_repeat'),
  ('cus_trial_former_paid');

insert into stripe.subscriptions (
  id,
  customer,
  status,
  trial_start,
  trial_end,
  created
)
values
  (
    'sub_trial_active',
    'cus_trial_active',
    'trialing',
    to_jsonb(EXTRACT(epoch FROM now())::bigint),
    to_jsonb(EXTRACT(epoch FROM now() + interval '21 days')::bigint),
    EXTRACT(epoch FROM now())::integer
  ),
  (
    'sub_trial_repeat',
    'cus_trial_repeat',
    'canceled',
    to_jsonb(EXTRACT(epoch FROM now() - interval '1 year')::bigint),
    to_jsonb(EXTRACT(epoch FROM now() - interval '344 days')::bigint),
    EXTRACT(epoch FROM now() - interval '1 year')::integer
  ),
  (
    'sub_trial_former_paid',
    'cus_trial_former_paid',
    'canceled',
    null,
    null,
    EXTRACT(epoch FROM now() - interval '1 year')::integer
  );

insert into founder_hub_private.pro_trial_identity_claims (
  kind,
  identity_hash,
  user_id
)
values (
  'email',
  extensions.digest(
    founder_hub_private.normalize_trial_email('jdoe@gmail.com'),
    'sha256'
  ),
  tests.user_id('trial_active')
);

delete from founder_hub.profiles
where id = tests.user_id('trial_missing_profile');

select tests.authenticate_as_service_role();

insert into founder_hub_private.account_deletion_jobs (owner_user_id)
values (tests.user_id('trial_deleting'));

select tests.clear_authentication();
reset role;

select ok(
  has_function_privilege(
    'cloud_member',
    'founder_hub.can_start_trial(text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'cloud_anonymous',
      'founder_hub.can_start_trial(text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'cloud_member',
      'founder_hub.reserve_pro_trial(text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'cloud_anonymous',
      'founder_hub.reserve_pro_trial(text,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'cloud_service',
      'founder_hub.release_pro_trial_reservation(uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'cloud_member',
      'founder_hub.release_pro_trial_reservation(uuid,uuid)',
      'EXECUTE'
    )
    and (
      select proc.prosecdef
        and 'search_path=""' = any(coalesce(proc.proconfig, array[]::text[]))
      from pg_proc as proc
      where proc.oid = 'founder_hub.can_start_trial(text)'::regprocedure
    )
    and (
      select proc.prosecdef
        and 'search_path=""' = any(coalesce(proc.proconfig, array[]::text[]))
      from pg_proc as proc
      where proc.oid = 'founder_hub.reserve_pro_trial(text,text)'::regprocedure
    )
    and (
      select not proc.prosecdef
        and 'search_path=""' = any(coalesce(proc.proconfig, array[]::text[]))
      from pg_proc as proc
      where proc.oid = 'founder_hub.release_pro_trial_reservation(uuid,uuid)'::regprocedure
    ),
  'Trial RPCs use least-privilege execution and pinned search paths'
);

with definition as (
  select lower(pg_get_functiondef(
    'founder_hub.reserve_pro_trial(text,text)'::regprocedure
  )) as body
)
select ok(
  body like '%pg_catalog.pg_advisory_xact_lock%'
    and body like '%pg_catalog.hashtextextended(v_user_id::text, 170001)%'
    and strpos(body, 'pg_catalog.pg_advisory_xact_lock')
      < strpos(body, 'from founder_hub_identity.users as auth_user')
    and strpos(body, 'from founder_hub_identity.users as auth_user')
      < strpos(body, 'from founder_hub.profiles as profile'),
  'Trial reservations serialize with account deletion before reading account state'
)
from definition;

select tests.authenticate_as('trial_new');
select ok(founder_hub.can_start_trial(), 'A new account can start its first trial');

select tests.clear_authentication();
select tests.authenticate_as('trial_email_alias');
select ok(
  not founder_hub.can_start_trial()
    and (select count(*) from founder_hub.reserve_pro_trial('web')) = 0,
  'A normalized email claim blocks eligibility and reservation'
);

select tests.clear_authentication();
select tests.authenticate_as('trial_missing_profile');
select is(
  founder_hub.can_start_trial(),
  false,
  'An cloud_member account without a server-owned profile fails closed'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('trial_customer_only');
select ok(
  founder_hub.can_start_trial(),
  'Creating a Stripe customer without a subscription does not consume the trial'
);

select lives_ok(
  $$
    insert into pro_trial_reservation_test_state (
      reservation_id,
      reserved_until
    )
    select reservation_id, reserved_until
    from founder_hub.reserve_pro_trial('web')
  $$,
  'An eligible account can atomically reserve its web trial'
);

select results_eq(
  $$select * from founder_hub.reserve_pro_trial('web')$$,
  $$select reservation_id, reserved_until from pro_trial_reservation_test_state$$,
  'A retry from the same channel receives the identical reservation'
);

select results_eq(
  $$select count(*) from founder_hub.reserve_pro_trial('native')$$,
  array[0::bigint],
  'A concurrent native flow cannot claim a web reservation'
);

select ok(
  (
    select reserved_until >= now() + interval '24 hours 59 minutes'
      and reserved_until <= now() + interval '25 hours 1 minute'
    from pro_trial_reservation_test_state
  ),
  'A web reservation outlives Stripe Checkout default expiration'
);

select ok(
  (select count(*) from founder_hub.reserve_pro_trial('invalid')) = 0
    and (select count(*) from founder_hub.reserve_pro_trial(null)) = 0,
  'Unknown and null reservation channels fail closed'
);

select is(
  founder_hub.can_start_trial(),
  false,
  'An active reservation is not advertised as another available trial'
);

select ok(
  not has_function_privilege(
    'cloud_member',
    'founder_hub.release_pro_trial_reservation(uuid,uuid)',
    'EXECUTE'
  ),
  'Authenticated clients cannot release trial reservations directly'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();

select founder_hub.release_pro_trial_reservation(
  tests.user_id('trial_customer_only'),
  gen_random_uuid()
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('trial_customer_only');

select results_eq(
  $$select * from founder_hub.reserve_pro_trial('web')$$,
  $$select reservation_id, reserved_until from pro_trial_reservation_test_state$$,
  'A mismatched release token cannot clear an active reservation'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();

select lives_ok(
  $$
    select founder_hub.release_pro_trial_reservation(
      tests.user_id('trial_customer_only'),
      (select reservation_id from pro_trial_reservation_test_state)
    )
  $$,
  'Trusted billing code can release a failed reservation'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('trial_customer_only');
select ok(
  founder_hub.can_start_trial(),
  'A released reservation restores first-trial eligibility'
);

select is(
  (select count(*) from founder_hub.reserve_pro_trial('native', 'abc123')),
  1::bigint,
  'An eligible account can reserve a trial with its device fingerprint'
);

select tests.clear_authentication();
select tests.authenticate_as('trial_new');
select ok(
  not founder_hub.can_start_trial('abc123')
    and (select count(*) from founder_hub.reserve_pro_trial('native', 'abc123')) = 0
    and founder_hub.can_start_trial(),
  'A claimed device blocks another account but no fingerprint remains eligible'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();
select founder_hub.release_pro_trial_reservation(
  tests.user_id('trial_customer_only'),
  (
    select profile.trial_reservation_id
    from founder_hub.profiles as profile
    where profile.id = tests.user_id('trial_customer_only')
  )
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('trial_customer_only');
select ok(
  founder_hub.can_start_trial()
    and (select count(*) from founder_hub.reserve_pro_trial('native', 'abc123')) = 1,
  'A released reservation can be retried without losing its claims'
);

select tests.clear_authentication();
select tests.authenticate_as('trial_active');
select isnt(
  founder_hub.can_start_trial(),
  true,
  'An active trial cannot be started again'
);

select results_eq(
  $$select count(*) from founder_hub.reserve_pro_trial('native')$$,
  array[0::bigint],
  'Subscription history cannot be bypassed through the reservation path'
);

select tests.clear_authentication();
select tests.authenticate_as('trial_repeat');
select isnt(
  founder_hub.can_start_trial(),
  true,
  'An old canceled trial remains ineligible after three months'
);

select tests.clear_authentication();
select tests.authenticate_as('trial_former_paid');
select isnt(
  founder_hub.can_start_trial(),
  true,
  'A former paid subscriber is not treated as a new trial user'
);

select tests.clear_authentication();
select tests.authenticate_as_service_role();
select is(
  obj_description('founder_hub.can_start_trial(text)'::regprocedure, 'pg_proc'),
  'Allows one new-user Pro trial per account, normalized email, and desktop device; prior subscription history makes the account ineligible.',
  'The once-per-account eligibility policy is documented in the schema'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('trial_anonymous');
select is(
  founder_hub.can_start_trial(),
  false,
  'Authenticated anonymous users cannot start trials'
);

select results_eq(
  $$select count(*) from founder_hub.reserve_pro_trial('native')$$,
  array[0::bigint],
  'Authenticated anonymous users cannot reserve trials'
);

select tests.clear_authentication();
reset role;
select tests.authenticate_as('trial_deleting');
select is(
  founder_hub.can_start_trial(),
  false,
  'Accounts pending durable deletion cannot start trials'
);

select results_eq(
  $$select count(*) from founder_hub.reserve_pro_trial('web')$$,
  array[0::bigint],
  'Accounts pending durable deletion cannot reserve trials'
);

select tests.clear_authentication();
reset role;
select is(
  founder_hub.can_start_trial(),
  false,
  'Anonymous callers fail closed'
);

select * from finish();
rollback;
