# Accounts: testing candidate

This build supports group publication, personal addons, first-sync review and
activation, selectable expiry timezones, automatic suspension, renewal, retry,
login repair, and verified removal. Use the dedicated Stremio test accounts and
Android devices agreed for acceptance testing.

## Start on this computer

From the project directory:

```powershell
npm run build
npm run managed:test
```

Open <http://127.0.0.1:1611/>. Use your existing manager login, or create one and
keep its UUID and password. This instance uses `data/managed-test`, its own generated encryption
key, and real Stremio transport. It ignores the existing database and encryption
key environment settings. Each new manager starts with managed sync paused.
Stop the foreground server with Ctrl+C; run `npm run managed:test` to reopen it.

If an earlier testing build let you create a manager but adding a Stremio account
reported **vault locked**, refresh the page and unlock with that same manager UUID
and password. Login now initializes missing vault metadata after authenticating
the existing identity. New manager passwords require at least 8 characters, and
registration checks vault setup before reporting success.

For a completely simulated walkthrough, `npm run managed:demo` prints a temporary
URL and synthetic login. It seeds a group, two staged users and one expired user.
Its provider and manifest transports are synthetic; it cannot contact Stremio.
Enter `stop` to clean up. The demo expires after 15 minutes.

## Acceptance walkthrough

1. Refresh and open **Accounts**. Previously added accounts connect automatically;
   an account already imported appears only once. Use **Add Stremio Account** to
   add a dedicated test account with its email and password. It appears in this
   same list with membership, personal-addon and activation controls. There is no
   export/import step. An older auth-key/OAuth account without a saved password
   shows **Save email and password** to complete unattended management.
   **Import from another installation** is only for migrating an external export.
2. Create a group, add complete configured manifest URLs, and save and publish its
   draft. Select users in the inventory and assign the published group. Use
   **Personal addons** for account-specific additions and disabled preferences.
3. Open **Membership**. New dated memberships default to `America/New_York`.
   Select or type another IANA timezone, enter its local cutoff and save. Reopen
   to confirm the chosen zone. Nonexistent clock-change times are rejected;
   repeated times require an explicit occurrence. Lifetime is a separate choice.
4. Open **Activate / preview**. Review the effective addon list and protection
   setting, then activate. Resume managed sync. Open **Sync / manage** and wait for
   **Verified**. Check the same Stremio login on Android, including addon order,
   custom names/catalogs and protected/default entries.
5. Publish a group change and verify the active member receives it. Confirm its
   personal addons and intentionally disabled entries are preserved. Pause and
   resume sync to check that pending work waits.
6. Set one account's expiry a few minutes ahead, in the chosen timezone. After the
   cutoff, check **Expired accounts**, the verified suspension status, and Android.
   Saved addon configuration and former group assignment must remain available.
   Expired accounts are rechecked about every five minutes, subject to backlog
   and provider availability. Ordinary active client edits are not periodically
   replaced.
7. Renew with a future cutoff or lifetime. Verify the current group and personal
   setup returns while intentionally disabled addons stay off.
8. On a disposable user, select **Clear addons and remove user**. The user should
   disappear only after an empty collection is read back from Stremio. A failure
   retains its credentials and offboarding status for retry. A removed provider
   identity remains reserved to block writes from stale legacy state. Refresh the
   browser and confirm the removed account does not return from an older cache.
9. Restart this test instance and confirm accounts, timezones and status survive.
   Check the last encrypted-backup timestamp. For invalid sessions, **Repair saved
   login** verifies the password and the enrolled identity before saving it.

Expiry changes the active addon collection. Android caches and playing streams
must be checked on the device; server verification does not assert that playback
was terminated or that the Stremio login was revoked.

## Separate Docker / Portainer test stack

Build the checked-out testing commit with:

```sh
docker compose -f compose.managed-test.yml up --build -d
```

This uses the separate `aiomanager-managed-test` Compose project and named data
volume, with port 1611 bound to loopback. On the VPS, use the existing HTTPS access
pattern with a separate test hostname, or an SSH tunnel. In Portainer, use this
repository's testing commit and `compose.managed-test.yml` as a separate Git stack.
The upstream production Compose file is not the testing stack. No production
deployment or registry publication is part of this candidate.

General deployments enable the runtime with `MANAGED_WRITES_ENABLED=true` and
resume the intended manager from the UI. Run one writer per database; PostgreSQL
uses a dedicated session advisory lock and SQLite uses an OS-locked sidecar.
An abrupt exit triggers a 30-second recovery quarantine. Do not delete the
`.writer-lock` file while a process is running. Other manager instances and older
software sharing a Stremio login cannot be fenced by this server.

## Daily backups and restore rehearsal

Background servers take an authenticated, encrypted database archive at startup
when due and once per 24 hours afterward. The latest 14 daily archives are kept
under `DATA_DIR/backups` (override with `MANAGED_BACKUP_DIR`). They include legacy
and managed database rows and the encryption keyring inside the encrypted archive.
Each provider mutation also records an encrypted pre-change collection snapshot.

Copy the archives off the VPS and keep the matching `server_secret.key` or
configured `ENCRYPTION_KEY` separately. The archive requires the primary key used
when it was made. Existing archives retain their historical data until their
retention period ends, including accounts later removed from the live database.

To restore to a **new** local directory with the matching application version:

```powershell
$env:AIO_BACKUP_KEY = (Get-Content -LiteralPath 'C:\safe-copy\server_secret.key' -Raw).Trim()
node server/restore-backup.js 'C:\safe-copy\archive.aiobackup' 'C:\aio-restored-test'
Remove-Item Env:AIO_BACKUP_KEY
```

The tool defaults to a new SQLite database and ignores `DATABASE_URL`. For a
PostgreSQL rehearsal, explicitly set `AIO_RESTORE_DATABASE_URL` to a separate,
empty test database. It refuses existing records, authenticates the entire archive
before committing, and restores managed sync and legacy Autopilot paused. The new
directory contains the restored key files; keep them with the restored data.
Start the restored instance with writes disabled and review it before resuming.
This archive requires its matching schema version; use that image to restore,
then perform normal forward migrations. Do not run an old image over a newer schema.

## Evidence and remaining acceptance

Local tests cover the complete synthetic HTTP lifecycle, native response bounds,
body timeouts, lost-response reconciliation, paused and changing policies, shared
transport budgets, cross-process SQLite exclusion, encrypted restart recovery,
selectable timezone transitions, 100-account execution, and backup tamper/restore
behavior. The same lifecycle and backup contracts run against PostgreSQL in CI;
CI also checks Windows/Linux and both container architectures.

Actual Stremio response normalization, disable-all behavior on the owner's Android
devices, the installed export's reconciliation, VPS throughput and the production
soak remain acceptance/release checks. See [planning/VERIFICATION.md](planning/VERIFICATION.md).
