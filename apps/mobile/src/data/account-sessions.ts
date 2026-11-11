/**
 * Sessions the signed-in account may act on: its own, its synced workspace's,
 * and unowned ones. Bind the account id twice; null (bypass mode) allows all.
 * Use with the sessions table aliased as `session`.
 */
export const ACCOUNT_SESSION_SQL = `(
    ? IS NULL
    OR session.owner_user_id = ?
    OR session.owner_user_id = (
      SELECT json_extract(value_json, '$.workspace_id')
      FROM app_settings
      WHERE id = 'cloudsync_workspace_binding'
    )
    OR session.owner_user_id IS NULL
    OR session.owner_user_id = '00000000-0000-0000-0000-000000000000'
  )`;
