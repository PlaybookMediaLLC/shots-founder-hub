begin;
select plan(7);

select tests.create_user('transport_pinned', 'transport-pinned@example.com');
select tests.create_user('transport_other', 'transport-other@example.com');

select has_table('founder_hub', 'sync_transport_overrides',
  'Per-account desktop transport pins live in their own table');

select ok(
  not has_table_privilege('cloud_member', 'founder_hub.sync_transport_overrides', 'SELECT')
    and not has_table_privilege('cloud_member', 'founder_hub.sync_transport_overrides', 'INSERT')
    and not has_table_privilege('cloud_anonymous', 'founder_hub.sync_transport_overrides', 'SELECT'),
  'Clients cannot read or write transport pins directly'
);

select ok(
  has_table_privilege('cloud_service', 'founder_hub.sync_transport_overrides', 'SELECT')
    and has_table_privilege('cloud_service', 'founder_hub.sync_transport_overrides', 'INSERT')
    and has_table_privilege('cloud_service', 'founder_hub.sync_transport_overrides', 'UPDATE')
    and has_table_privilege('cloud_service', 'founder_hub.sync_transport_overrides', 'DELETE'),
  'Only trusted service code manages transport pins'
);

select tests.authenticate_as_service_role();
insert into founder_hub.sync_transport_overrides (user_id, transport, note)
values (tests.user_id('transport_pinned'), 'replica', 'pilot');

select results_eq(
  format(
    $$select transport from founder_hub.sync_transport_overrides where user_id = %L$$,
    tests.user_id('transport_pinned')
  ),
  $$values ('replica'::text)$$,
  'The API can read the pinned transport for an account'
);

select is_empty(
  format(
    $$select transport from founder_hub.sync_transport_overrides where user_id = %L$$,
    tests.user_id('transport_other')
  ),
  'Accounts without a pin fall back to the server default'
);

select throws_ok(
  format(
    $$insert into founder_hub.sync_transport_overrides (user_id, transport) values (%L, 'witness')$$,
    tests.user_id('transport_other')
  ),
  '23514',
  null,
  'Unknown transports are rejected'
);

select throws_ok(
  format(
    $$insert into founder_hub.sync_transport_overrides (user_id, transport) values (%L, 'sqlite_sync')$$,
    tests.user_id('transport_pinned')
  ),
  '23505',
  null,
  'An account carries at most one pin'
);

select tests.clear_authentication();
reset role;

select * from finish();
rollback;
