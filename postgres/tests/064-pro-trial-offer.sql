begin;
select plan(5);

select tests.create_user('offer_referrer', 'offer-referrer@example.com');
select tests.create_user('offer_work', 'jane@acme-offer.io');
select tests.create_user('offer_personal', 'jane.offer@gmail.com');
select tests.create_user('offer_referred', 'referred.offer@gmail.com');

update founder_hub_identity.users
set email_confirmed_at = now()
where id in (
  tests.user_id('offer_work'),
  tests.user_id('offer_personal'),
  tests.user_id('offer_referred')
);

update founder_hub.profiles
set stripe_customer_id = 'cus_offer_referrer'
where id = tests.user_id('offer_referrer');

insert into stripe.customers (id) values ('cus_offer_referrer');
insert into stripe.subscriptions (id, customer, status, created)
values (
  'sub_offer_referrer',
  'cus_offer_referrer',
  'active',
  extract(epoch from now())::integer
);

select ok(
  has_function_privilege('cloud_member', 'founder_hub.get_pro_trial_offer()', 'EXECUTE')
    and not has_function_privilege('cloud_anonymous', 'founder_hub.get_pro_trial_offer()', 'EXECUTE'),
  'Only cloud_member users can read their trial offer'
);

select tests.authenticate_as('offer_referrer');
create temporary table offer_referral_code as
select code from founder_hub.get_or_create_referral_invites() where slot = 1;
grant select on offer_referral_code to cloud_member;
select tests.clear_authentication();
reset role;

select tests.authenticate_as('offer_work');
select is(founder_hub.get_pro_trial_offer(), 'work_email', 'A custom-domain email gets the work email offer');
select tests.clear_authentication();
reset role;

select tests.authenticate_as('offer_personal');
select is(founder_hub.get_pro_trial_offer(), 'personal_email', 'A public email domain gets the personal email offer');
select tests.clear_authentication();
reset role;

select tests.authenticate_as('offer_referred');
select ok(founder_hub.claim_referral((select code from offer_referral_code)), 'The referred account claims an invite');
select is(founder_hub.get_pro_trial_offer(), 'referral', 'A referral wins over a personal email');
select tests.clear_authentication();
reset role;

select * from finish();
rollback;
