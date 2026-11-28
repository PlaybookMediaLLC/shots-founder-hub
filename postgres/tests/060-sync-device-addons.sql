begin;
select plan(13);

select tests.create_user('addon_pro', 'addon-pro@example.com');

update founder_hub.profiles
set stripe_customer_id = 'cus_addon_pro'
where id = tests.user_id('addon_pro');

insert into stripe.customers (id) values ('cus_addon_pro') on conflict (id) do nothing;
insert into stripe.prices (id, lookup_key)
values
  ('price_addon_monthly', 'hyprnote_sync_device_addon_monthly'),
  ('price_addon_yearly', 'hyprnote_sync_device_addon_yearly'),
  ('price_pro_monthly', 'hyprnote_pro_monthly_test')
on conflict (id) do nothing;
insert into stripe.subscriptions (id, customer, status)
values ('sub_addon_pro', 'cus_addon_pro', 'active')
on conflict (id) do nothing;
insert into stripe.subscription_items (id, subscription, price, quantity)
values ('si_addon_pro_base', 'sub_addon_pro', 'price_pro_monthly', 1)
on conflict (id) do nothing;

select is(founder_hub.get_sync_device_limit(tests.user_id('addon_pro')), 5,
  'A Pro subscription without add-ons keeps five included slots');

insert into stripe.subscription_items (id, subscription, price, quantity)
values ('si_addon_pro_devices', 'sub_addon_pro', 'price_addon_monthly', 2);

select is(founder_hub.get_sync_device_limit(tests.user_id('addon_pro')), 7,
  'Each add-on unit adds one sync device slot');

update stripe.subscription_items set quantity = 4 where id = 'si_addon_pro_devices';
select is(founder_hub.get_sync_device_limit(tests.user_id('addon_pro')), 9,
  'Add-on quantity changes update the allowance');

update stripe.subscription_items set deleted = true where id = 'si_addon_pro_devices';
select is(founder_hub.get_sync_device_limit(tests.user_id('addon_pro')), 5,
  'Removed add-on items no longer grant slots');

update stripe.subscription_items set deleted = false, price = 'price_addon_yearly' where id = 'si_addon_pro_devices';
select is(founder_hub.get_sync_device_limit(tests.user_id('addon_pro')), 9,
  'Yearly add-on prices count the same way');

update stripe.subscriptions set status = 'canceled' where id = 'sub_addon_pro';
select is(founder_hub.get_sync_device_limit(tests.user_id('addon_pro')), 5,
  'Add-ons on a canceled subscription do not grant slots');

update stripe.subscriptions set status = 'active' where id = 'sub_addon_pro';
select tests.authenticate_as_service_role();
select founder_hub.claim_personal_workspace_e2ee_key(tests.user_id('addon_pro'), 'abcdefghijklmnopqrstuv');
do $$begin
  for ordinal in 1..8 loop
    perform * from founder_hub.claim_sync_device(tests.user_id('addon_pro'), 'addon-device-' || ordinal::text);
  end loop;
end$$;
select results_eq(
  format(
    $$select allowed, enrollment_status, device_count
      from founder_hub.register_e2ee_device_enrollment(%L, 'addon-device-9', 'Phone', %L, null)$$,
    tests.user_id('addon_pro'),
    rpad('A', 43, 'A')
  ),
  $$values (true, 'pending'::text, 9::bigint)$$,
  'Encrypted enrollment above five devices honors purchased slots'
);
select is((select allowed from founder_hub.claim_sync_device(tests.user_id('addon_pro'), 'addon-device-9')), true,
  'Purchased slots can be claimed');
select is((select allowed from founder_hub.claim_sync_device(tests.user_id('addon_pro'), 'addon-device-10')), false,
  'Claims stop at the purchased allowance');

reset role;
update stripe.subscription_items set deleted = true where id = 'si_addon_pro_devices';
select tests.authenticate_as_service_role();
select is((select allowed from founder_hub.claim_sync_device(tests.user_id('addon_pro'), 'addon-device-9')), true,
  'Removing purchased slots preserves existing device connections');
select is((select allowed from founder_hub.claim_sync_device(tests.user_id('addon_pro'), 'addon-device-10')), false,
  'Removing purchased slots blocks new claims above five included devices');
select is((select allowed from founder_hub.register_e2ee_device_enrollment(tests.user_id('addon_pro'), 'addon-device-10', 'Phone', rpad('B', 43, 'B'), 'addon-device-1')), false,
  'An over-limit account must free enough slots before replacement');
select is((select count(*) from founder_hub.sync_devices where user_id = tests.user_id('addon_pro')), 9::bigint,
  'A rejected replacement leaves existing connections intact');

select * from finish();
rollback;
