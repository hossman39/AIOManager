# Accounts: testing candidate

This build supports individual account setups, optional groups, account-specific
overrides, first-sync review and
activation, selectable expiry timezones, selective addon suspension, renewal, retry,
login repair, group deletion, an optional Stremio expiry notice, and verified removal. Use the dedicated Stremio test accounts and
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
URL and synthetic login. It seeds an independent account, a group member ready
for first sync, and an expired member.
Its provider and manifest transports are synthetic; it cannot contact Stremio.
Enter `stop` to clean up. The demo expires after 15 minutes.

## Acceptance walkthrough

1. Refresh and open **Accounts**. Previously added accounts connect automatically
   and imported matches appear only once. Use **Add account** for a dedicated
   Stremio test login, then **Open account**. An imported server-only account opens
   the same detail screen. The account list contains summaries, search and filters;
   groups and sync settings have their own screens.
2. Leave **Group** set to **No group — individual setup**. On **Addons**, confirm
   the installed addon cards appear. Try Configure, Customize, Catalogs, Reorder,
   enable/disable, Library and Install addon. Changes form a draft until **Save
   changes**. Saving the initial setup does not write to Stremio before first sync.
   Navigation warns before discarding edits. An older auth-key/OAuth account can
   still open its manual addon controls; **Save Stremio login** enables unattended
   sync, groups and expiry.
3. Open **Membership**. New dated memberships default to `America/New_York`.
   Select or type another IANA timezone, enter its local cutoff and save. Reopen
   to confirm the chosen zone. Nonexistent clock-change times are rejected;
   repeated times require an explicit occurrence. Lifetime is a separate choice.
4. Open **Sync & access**, choose **Preview first sync**, review the addon list,
   confirm it and choose **Start sync**. No group is required. If paused, open
   **Accounts → ⋯ → Sync settings** and resume sync. Wait for **verified** in
   **Sync & access**. On **Addons**, use **Check Stremio** to see the actual installed
   list and the email being checked. Then check the same Stremio login on Android, including
   order, names, catalogs and protected/default entries.
5. On **Groups**, create a group, add addons, and click **Publish changes** once.
   This saves the edits and queues sync for existing members together. In the open
   group, choose **Add members**, search/select existing accounts, then **Add
   selected members**. Confirm they appear in the member list. Accounts moved
   from another group use the new group's shared addons and keep account-only
   addons. Accounts whose sync has not started remain inactive. You can also use
   the account's **Group** tab or **Assign group** on Accounts.
   Open one member and customize an addon: the other members and the
   shared group must remain unchanged. Publish another group change; untouched
   addons follow it while that account's customizations remain. **Use group
   version** resets an individual addon override. Leave the group and confirm the
   complete saved setup is retained for independent management. Pause and resume
   from Sync settings to check that changes wait while paused.
   Open a disposable group and choose **Delete group**. Confirm the dialog; the
   group should disappear and its members should remain as individual accounts,
   with their complete addon setups, customizations and memberships preserved.
6. In the group editor, set **Disable on expiry** for each addon. For a typical
   setup, check Streams/AIOStreams and leave Cinemeta, AIOMetadata and subtitles
   unchecked. **Keep browsing addons** selects this using declared resources;
   addons that also provide streams remain checked. Review the choices and click
   **Publish changes**. Old groups still
   disable all addons until you publish an explicit choice. Individual accounts
   can make the same choices; group addons inherit the group's expiry settings
   even when their names or catalogs are customized for one account.
   Set one account's expiry a few minutes ahead, in the chosen timezone. After the
   cutoff, check **Expired accounts**, the verified suspension status, and Android.
   **Expired · sync pending** must not be mistaken for **Expired · sync verified**;
   a staged expired account says **sync not started**. Only selected addons have
   their switches labeled **On renewal**. **Check Stremio** shows the installed list
   and whether it matches the selected expiry setup. Retained browsing addons must
   not produce a failure warning. Already switched-off addons must stay off.
   Saved addon configuration and former group assignment must remain available.
   Expired accounts are rechecked about every five minutes, subject to backlog
   and provider availability. Ordinary active client edits are not periodically
   replaced.
   To show an expiry card, open **Accounts → ⋯ → Sync settings → Expiry notice in
   Stremio**, enable it, and save the address of this AIOManager installation,
   a message, and an optional renewal/contact URL. Existing expired accounts are
   queued for this change. Check that the unchecked browsing addons and
   **Membership expired** are installed, while selected streaming addons are gone.
   Open a movie and a series episode: browsing and details should still work, with
   “Your box has expired. Please reach out to your contact to renew.” (or your
   custom message) in the source list. The notice also provides a Home/Discover card.
   Without a renewal URL, the notice opens a simple information page.
   The URL must be reachable from the Stremio device and allow unauthenticated
   access to `/api/notice/*`. `127.0.0.1:1611` works only on this Windows computer;
   use the test installation's public HTTPS address for a TV or another device.
7. Renew with a future cutoff or lifetime. Verify the current group and personal
   setup returns while intentionally disabled addons stay off and the expiry
   notice is removed.
8. On a disposable account, select **Sync & access → Remove this account → Clear
   addons and remove account**. The account should
   disappear only after an empty collection is read back from Stremio. A failure
   retains its credentials and offboarding status for retry. A removed provider
   identity remains reserved to block writes from stale legacy state. Refresh the
   browser and confirm the removed account does not return from an older cache.
9. Restart this test instance and confirm accounts, timezones and status survive.
   Check the last encrypted-backup timestamp. For invalid sessions, **Repair saved
   login** verifies the password and the enrolled identity before saving it.

**Accounts → ⋯ → Import accounts** is for migrating an export from another
installation. It retains the credential preview and duplicate/conflict checks;
ordinary account creation needs no export/import step.

Expiry changes the active addon collection. Android caches and playing streams
must be checked on the device; server verification does not assert that playback
was terminated or that the Stremio login was revoked.
If Stremio still shows defaults while **Check Stremio** shows your configured
addons, fully close/reopen Stremio and confirm the app is signed into the displayed
email. An account marked **Sync not started** retains its existing Stremio setup
until its first sync is reviewed and started.

The notice follows Stremio's [manifest and resource protocol](https://stremio.github.io/stremio-addon-sdk/api/responses/manifest.html)
and uses an [external link in the source list](https://stremio.github.io/stremio-addon-sdk/api/responses/stream.html).
It contains no account identity, password, auth key, or individual membership date.

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
