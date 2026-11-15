begin;
select plan(4);

select tests.create_user('owner', 'owner@example.com');
select tests.create_user('other', 'other@example.com');

select tests.authenticate_as('owner');

select lives_ok(
  $$insert into founder_hub_files.objects (bucket_id, name, owner)
    values ('audio-files', founder_hub_identity.user_id()::text || '/test.wav', founder_hub_identity.user_id())$$,
  'Owner can upload to own folder'
);

select results_eq(
  $$select count(*) from founder_hub_files.objects where bucket_id = 'audio-files'$$,
  array[1::bigint],
  'Owner can view own files'
);

select tests.clear_authentication();
select tests.authenticate_as('other');

select throws_ok(
  $$insert into founder_hub_files.objects (bucket_id, name, owner)
    values ('audio-files', tests.user_id('owner')::text || '/hack.wav', founder_hub_identity.user_id())$$,
  '42501',
  null,
  'Cannot upload to another user folder'
);

select results_eq(
  $$select count(*) from founder_hub_files.objects where bucket_id = 'audio-files'$$,
  array[0::bigint],
  'Other user cannot view files in private bucket'
);

select * from finish();
rollback;
