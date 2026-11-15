CREATE OR REPLACE FUNCTION founder_hub.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  matched_customer_id text;
BEGIN
  IF NEW.email IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        pg_catalog.lower(pg_catalog.btrim(NEW.email)),
        4030317
      )
    );
  END IF;

  SELECT customer.id
  INTO matched_customer_id
  FROM stripe.customers AS customer
  WHERE NEW.email IS NOT NULL
    AND customer.email IS NOT NULL
    AND NOT customer.deleted
    AND pg_catalog.lower(pg_catalog.btrim(customer.email))
      = pg_catalog.lower(pg_catalog.btrim(NEW.email))
    AND NOT EXISTS (
      SELECT 1
      FROM founder_hub.profiles AS linked_profile
      WHERE linked_profile.stripe_customer_id = customer.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM founder_hub.workspaces AS linked_workspace
      WHERE linked_workspace.stripe_customer_id = customer.id
    )
  ORDER BY
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM stripe.subscriptions AS subscription
        WHERE subscription.customer = customer.id
          AND subscription.status IN ('active', 'past_due', 'unpaid')
      ) THEN 0
      WHEN EXISTS (
        SELECT 1
        FROM stripe.subscriptions AS subscription
        WHERE subscription.customer = customer.id
          AND subscription.status IN ('trialing', 'paused')
      ) THEN 1
      WHEN EXISTS (
        SELECT 1
        FROM stripe.subscriptions AS subscription
        WHERE subscription.customer = customer.id
      ) THEN 2
      ELSE 3
    END,
    customer.created ASC NULLS LAST,
    customer.id
  LIMIT 1;

  INSERT INTO founder_hub.profiles (id, stripe_customer_id)
  VALUES (NEW.id, matched_customer_id);

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION founder_hub.handle_user_email_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  matched_customer_id text;
BEGIN
  IF OLD.email IS DISTINCT FROM NEW.email THEN
    IF NEW.email IS NOT NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          pg_catalog.lower(pg_catalog.btrim(NEW.email)),
          4030317
        )
      );
    END IF;

    SELECT profile.stripe_customer_id
    INTO matched_customer_id
    FROM founder_hub.profiles AS profile
    WHERE profile.id = NEW.id;

    IF matched_customer_id IS NULL THEN
      SELECT customer.id
      INTO matched_customer_id
      FROM stripe.customers AS customer
      WHERE NEW.email IS NOT NULL
        AND customer.email IS NOT NULL
        AND NOT customer.deleted
        AND pg_catalog.lower(pg_catalog.btrim(customer.email))
          = pg_catalog.lower(pg_catalog.btrim(NEW.email))
        AND NOT EXISTS (
          SELECT 1
          FROM founder_hub.profiles AS linked_profile
          WHERE linked_profile.stripe_customer_id = customer.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM founder_hub.workspaces AS linked_workspace
          WHERE linked_workspace.stripe_customer_id = customer.id
        )
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM stripe.subscriptions AS subscription
            WHERE subscription.customer = customer.id
              AND subscription.status IN ('active', 'past_due', 'unpaid')
          ) THEN 0
          WHEN EXISTS (
            SELECT 1
            FROM stripe.subscriptions AS subscription
            WHERE subscription.customer = customer.id
              AND subscription.status IN ('trialing', 'paused')
          ) THEN 1
          WHEN EXISTS (
            SELECT 1
            FROM stripe.subscriptions AS subscription
            WHERE subscription.customer = customer.id
          ) THEN 2
          ELSE 3
        END,
        customer.created ASC NULLS LAST,
        customer.id
      LIMIT 1;

      IF matched_customer_id IS NOT NULL THEN
        UPDATE founder_hub.profiles AS profile
        SET stripe_customer_id = matched_customer_id
        WHERE profile.id = NEW.id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub.handle_new_user()
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.handle_new_user()
  TO cloud_identity_admin;

REVOKE ALL ON FUNCTION founder_hub.handle_user_email_update()
  FROM PUBLIC, cloud_anonymous, cloud_member;
GRANT EXECUTE ON FUNCTION founder_hub.handle_user_email_update()
  TO cloud_identity_admin;

WITH account_emails AS (
  SELECT
    normalized_account.id,
    normalized_account.email,
    pg_catalog.count(*) OVER (
      PARTITION BY normalized_account.email
    ) AS account_count
  FROM (
    SELECT
      account.id,
      pg_catalog.lower(pg_catalog.btrim(account.email)) AS email
    FROM founder_hub_identity.users AS account
    WHERE account.email IS NOT NULL
  ) AS normalized_account
),
ranked_candidates AS (
  SELECT
    profile.id AS profile_id,
    customer.id AS customer_id,
    pg_catalog.row_number() OVER (
      PARTITION BY profile.id
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM stripe.subscriptions AS subscription
            WHERE subscription.customer = customer.id
              AND subscription.status IN ('active', 'past_due', 'unpaid')
          ) THEN 0
          WHEN EXISTS (
            SELECT 1
            FROM stripe.subscriptions AS subscription
            WHERE subscription.customer = customer.id
              AND subscription.status IN ('trialing', 'paused')
          ) THEN 1
          WHEN EXISTS (
            SELECT 1
            FROM stripe.subscriptions AS subscription
            WHERE subscription.customer = customer.id
          ) THEN 2
          ELSE 3
        END,
        customer.created ASC NULLS LAST,
        customer.id
    ) AS rank
  FROM founder_hub.profiles AS profile
  JOIN account_emails AS account
    ON account.id = profile.id
  JOIN stripe.customers AS customer
    ON customer.email IS NOT NULL
    AND NOT customer.deleted
    AND pg_catalog.lower(pg_catalog.btrim(customer.email))
      = account.email
  WHERE profile.stripe_customer_id IS NULL
    AND account.account_count = 1
    AND NOT EXISTS (
      SELECT 1
      FROM founder_hub_private.account_deletion_jobs AS deletion
      WHERE deletion.owner_user_id = profile.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM founder_hub.profiles AS linked_profile
      WHERE linked_profile.stripe_customer_id = customer.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM founder_hub.workspaces AS linked_workspace
      WHERE linked_workspace.stripe_customer_id = customer.id
    )
)
UPDATE founder_hub.profiles AS profile
SET stripe_customer_id = candidate.customer_id
FROM ranked_candidates AS candidate
WHERE candidate.profile_id = profile.id
  AND candidate.rank = 1
  AND profile.stripe_customer_id IS NULL;
