# Shots and Founder Hub parity plan

**Status:** follow-up work after the central-auth handoff PRs (#3 in Founder Hub and #499 in Shots).

Shots is the account, settings, and billing authority. Founder Hub authenticates with Shots and opens the relevant Shots settings page. There are no existing users to migrate, so this plan does not include bulk identity or library import. Validate fresh-account onboarding and account binding instead.

## Workstreams

### 1. Settings parity and desktop-independent settings

- Build and maintain a settings inventory from Founder Hub's current settings screens, with a destination, owner, and status for every page and control.
- Route referrals, imports, insights, and stats as well as CRM and billing into their Shots destinations. Keep billing actions inside Shots billing.
- Port the remaining AI settings behaviors: provider/model discovery, local model downloads where supported, and subscription sign-in. Preserve credential encryption and provider validation.
- Remove the desktop-profile prerequisite from CRM, developer, and billing controls; require a device only for settings that read or change local desktop state.
- Verify each destination for a signed-in account, a missing desktop profile, and an account mismatch. No handoff may put a bearer token or secret in a URL.

**Acceptance:** the inventory has no missing or ambiguous destination; every listed setting has an owner and a passing route/behavior check; CRM, developer, and billing work from a browser-only session; billing opens Shots billing.

### 2. CRM connection verification

- Add a real **Test** action for connected HubSpot, Attio, Salesforce, Pipedrive, and Close accounts using the account-scoped Shots integration API.
- Return provider-specific connection or authorization failures to the user without exposing credentials. Reuse the existing CRM provider adapters and contact lookup rules.
- Cover successful contact lookup, no match, expired/revoked authorization, disconnect, and reconnect in provider and authenticated browser tests.

**Acceptance:** every supported provider can be tested from Shots settings; the test proves a scoped contact lookup, and each failure is visible and recoverable without leaking secrets.

### 3. Referral invite and reward in Shots billing

- Add `/invite/{code}` signup handling in Shots. Preserve and validate the invite code through sign-up, then claim it against the authenticated Shots account exactly once.
- Implement the stated reward policy in Shots billing: when an invited friend starts a free trial, grant the friend 30 days of Pro and the referrer one month of Pro. Payment is not a qualification requirement; do not trigger rewards from `invoice.paid`.
- Record claims and rewards in the existing billing/credit ledger with idempotency, auditability, and protections against self-referral, replay, duplicate accounts, and revoked or invalid codes.
- Make the Founder Hub referral screen link to the invite route and show claim/reward status from Shots.

**Acceptance:** an end-to-end test proves code carry-through, single claim, the no-payment free-trial qualification, both rewards, duplicate-event idempotency, and the rejected self-referral/invalid-code cases.

### 4. Paired desktop settings lifecycle

- Extend the existing combined local launcher with a paired test command that starts both repositories and supplies their URLs and test credentials. Fail when required gateway, storage, or revocation assertions are omitted.
- Exercise the full path: change a setting in Shots, verify the update reaches desktop storage, restart the desktop against that storage, and verify the setting remains. Execute one native desktop command and verify its completion appears in Shots.
- Add offline-conflict and revoked-session cases. Ensure the desktop uses freshly built Rust/API code so a stale prebuilt binary cannot produce a false pass.
- Keep setup/doctor checks for required tool versions, migrations, OAuth configuration, port conflicts, and binary freshness. Use isolated test users/workspaces and databases; never reset the developer's everyday data.

**Acceptance:** one documented local command passes the full authenticated round-trip and failure cases across both repos; logs identify both revisions and the native command result. The macOS CI lane runs the same native lifecycle with the WebDriver credential configured.

## Delivery and gates

1. Implement the settings inventory and browser-only settings fixes.
2. Finish CRM verification and provider tests.
3. Implement referral claim and rewards through Shots billing, then run billing idempotency and end-to-end tests.
4. Extend the paired launcher and prove the desktop lifecycle locally before wiring the same command into CI.
5. Run paired auth/API/browser CI on changes to either repository using compatible revisions; keep the actual native desktop test in a macOS job. A missing WebDriver secret must be reported as an unverified native test, never as proof of round-trip success.
6. Close the work only when every settings inventory row and each acceptance test above is green. Release changes through `develop` to `main` PRs using merge commits.

## Current gaps

- CRM settings currently route to Shots, but do not provide the original **Test** contact lookup flow.
- Referral routing currently reaches Shots, but there is no invite-code signup route or reward ledger behavior in Shots billing.
- The native settings persistence lane skips its binary round-trip when `CN_API_KEY_WEBDRIVER` is absent. The paired web/auth integration does not prove persistence across a real desktop restart.
- The settings inventory, full AI provider parity, offline conflict/revoked-session lifecycle, and single-command paired developer flow remain to be completed and verified.
