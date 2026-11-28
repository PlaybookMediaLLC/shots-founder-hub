begin;
select plan(7);

select tests.create_user('e2ee_owner', 'e2ee-owner@example.com');

select has_column(
  'founder_hub',
  'workspaces',
  'e2ee_key_id',
  'Workspaces store only the non-secret E2EE key identity'
);

select ok(
  not has_function_privilege(
    'cloud_member',
    'founder_hub.claim_personal_workspace_e2ee_key(uuid, text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'cloud_anonymous',
      'founder_hub.claim_personal_workspace_e2ee_key(uuid, text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'cloud_service',
      'founder_hub.claim_personal_workspace_e2ee_key(uuid, text)',
      'EXECUTE'
    ),
  'Only trusted service code can claim an E2EE key identity'
);

select tests.authenticate_as_service_role();

select is(
  (
    select key_id
    from founder_hub.claim_personal_workspace_e2ee_key(
      tests.user_id('e2ee_owner'),
      'abcdefghijklmnopqrstuv'
    )
  ),
  'abcdefghijklmnopqrstuv',
  'The first valid key identity is claimed'
);

select is(
  (
    select key_id
    from founder_hub.claim_personal_workspace_e2ee_key(
      tests.user_id('e2ee_owner'),
      'abcdefghijklmnopqrstuv'
    )
  ),
  'abcdefghijklmnopqrstuv',
  'Claiming the same key identity is idempotent'
);

select is(
  (
    select key_id
    from founder_hub.claim_personal_workspace_e2ee_key(
      tests.user_id('e2ee_owner'),
      'zyxwvutsrqponmlkjihgfe'
    )
  ),
  'abcdefghijklmnopqrstuv',
  'A different key cannot replace the claimed identity'
);

select throws_ok(
  $$
    select *
    from founder_hub.claim_personal_workspace_e2ee_key(
      tests.user_id('e2ee_owner'),
      'invalid'
    )
  $$,
  '22023',
  'E2EE key identity is invalid',
  'Malformed key identities are rejected'
);

select tests.authenticate_as('e2ee_owner');

select throws_ok(
  $$
    select *
    from founder_hub.claim_personal_workspace_e2ee_key(
      tests.user_id('e2ee_owner'),
      'abcdefghijklmnopqrstuv'
    )
  $$,
  '42501',
  null,
  'Authenticated clients cannot call the claim function directly'
);

select * from finish();
rollback;
