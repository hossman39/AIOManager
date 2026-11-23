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

## Nuvio pilot

Run `npm run build` and `npm run managed:test -- --nuvio-pilot` in this checkout. Open
<http://127.0.0.1:1612/>. This uses the real Nuvio and Stremio services and a separate
SQLite database and key in `data/nuvio-pilot`. A manager on another installation needs
a login on this instance. Use a dedicated client account for the test.

For a TV on the same home network, start a second terminal on the PC and run
`node scripts/nuvio-pilot-notice.mjs <PC-Wi-Fi-IPv4>`. Use the base URL it prints
in **Settings → Account sync → Expiry notice** and save. This listener serves the
public notice on port 1613 using the pilot database in read-only mode. The manager
stays on port 1612. Keep the listener running during the test. After sync shows
**verified**, use **Refresh Addons** on the TV's managed Nuvio profile. For clients
outside that LAN, use the deployed manager's reachable HTTPS base URL instead.

1. In **Settings → Account sync**, resume managed writes. Enable **Expiry notice**.
   Enter an address for this test installation that the playback device can reach.
   For a TV, route its HTTPS notice address to this instance. A loopback URL only works
   on the test computer. Set the message to “Your membership has expired. Please
   reach out to your contact to renew.” The optional contact URL can be
   `https://t.me/your_username`. A Telegram profile link automatically puts
   the handle on the notice poster and in the source list so it can be read on TV.
2. In **Accounts → Add account → Nuvio**, choose **Connect existing** or **Create new**.
   If managed sync is paused, **Resume sync and create account** enables queued
   work for this manager and submits the signup. An existing login can be added while
   sync is paused. If Nuvio requires email confirmation, confirm it and sign in with
   **Connect existing**. Select the primary profile. Profiles that
   share its addons follow this setup. Enroll and set a membership on each additional
   independent profile you intend to manage. When moving a client, choose **Copy
   membership and group from Stremio** and select their account. This copies the
   current membership, including its exact cutoff and any manual access override.
   A published group with a set membership syncs automatically. Later changes to
   either account are independent. Individual addon overrides and watch history
   are separate from this step.
3. Mark each playback addon **Disable on expiry** in the group and publish it.
   Set a test membership. In the account’s **Group** tab, select the group and click
   **Save group**. Wait for **verified** in **Sync & access**. If you save the group
   first, saving the membership starts sync automatically. For an individual setup,
   use **Preview first sync** and **Start sync** instead. On the Nuvio device
   sign in to the same account and profile and play a title with a managed source.
4. In **Membership → Account access**, click **Expire now**. After **verified**, use **Check Nuvio**, then
   use **Refresh Addons** in Nuvio and try a fresh title on the device. Confirm
   the message and optional Telegram action. Refresh again after renewing.
   Click **Keep active** and verify that the original sources and playback return.
   Click **Follow membership** to resume using the saved date or lifetime membership.
   Each override stays in effect until you change it, including across edits to the membership date.
   Verification measures the hosted addon list. Device caches, already issued stream
   URLs, user-installed sources, plugins and unenrolled profiles have their own behavior.
   Enforce expiry at your source server if an issued or cached URL must stop working.
5. On the Nuvio account open **Sync & access → Import watch history from Stremio**.
   Pick a managed Stremio account or choose **Use another login** and enter the
   source credentials for this import. Select the destination profile, preview,
   then confirm. Check one finished movie,
   a watched episode and a partially played title on Nuvio. A second preview should
   have nothing to add unless the source or destination changed. Series with a watched
   bitmap need matching IMDb/Cinemeta episode metadata. Unmatched series are listed
   in the preview. Items retain their source content IDs, so choose the same catalog
   identifiers when checking playback on the device. The import copies watch states
   and resume points available through Stremio, with no ongoing cross-service sync.
6. In **Accounts**, use the **Stremio** and **Nuvio** buttons with the search or
   membership filters. On a managed Stremio account choose **Convert to Nuvio →
   Convert and import**. The manager uses the saved login for the primary Nuvio
   profile and copies the membership, access override, group and portable addon
   settings. A previously configured Nuvio profile keeps its existing setup.
   Review the history counts and any unmatched titles. If Nuvio requests email
   confirmation, confirm the email and choose **Retry conversion**. Both accounts
   remain available in Accounts.

## Acceptance walkthrough

1. Refresh and open **Accounts**. Previously added accounts connect automatically
   and imported matches appear only once. Use **Add account** for a dedicated
   Stremio test login, then **Open account**. An imported server-only account opens
   the same detail screen. The account list contains summaries, search and filters;
   groups and sync settings have their own screens.
   Use the pencil beside a name, group or membership to edit it directly on the
   account card. Saving refreshes the card. **Select** reveals checkboxes and
   **Bulk actions** for expiry/lifetime, group assignment, removal from groups and
   sync. All accounts appear in one scrollable list. Search or filter the list and
   select up to 200 matching accounts at once. Group removal keeps the accounts and their setups;
   bulk sync skips accounts whose first sync has not started.
   Global sync controls and the Stremio expiry notice are under **Settings →
   Account sync**. Old `/accounts/sync-settings` bookmarks redirect there.
2. Leave **Group** set to **No group — individual setup**. On **Addons**, confirm
   the installed addon cards appear. Try Configure, Customize, Catalogs, Reorder,
   enable/disable, Library and Install addon. Changes form a draft until **Save
   changes**. Saving the initial setup does not write to Stremio before first sync.
   Navigation warns before discarding edits. An older auth-key/OAuth account can
   still open its manual addon controls; **Save Stremio login** enables unattended
   sync, groups and expiry.
3. Open **Membership**. New dated memberships default to `America/New_York`.
   Select the last date of access and save. Reopen to confirm the date and timezone.
   A dated membership stays active through that local day, including clock changes.
   Lifetime is a separate choice.
4. Open **Sync & access**, choose **Preview first sync**, review the addon list,
   confirm it and choose **Start sync**. No group is required. If paused, open
   **Settings → Account sync** and resume sync. Wait for **verified** in
   **Sync & access**. On **Addons**, use **Check Stremio** to see the actual installed
   list and the email being checked. Then check the same Stremio login on Android, including
   order, names, catalogs and protected/default entries.
5. On **Groups**, create a group, add addons, and click **Publish changes** once.
   This saves the edits and queues sync for existing members together. In the open
   group, open the **Members** tab and choose **Add members**. Search/select existing
   accounts in the dialog, then **Add selected members**. Confirm they appear in
   the compact member list. Use search, status filters and Previous/Next to find
   members; each page shows up to 10 rows. Selection carries across pages and
   filters. **Select all matching** adds matching accounts, up to 200 selected.
   Select member checkboxes and choose **Bulk update** to set a common expiry
   date and timezone, choose lifetime, move to another group,
   remove from this group, or sync addons now. Removal keeps the accounts and their
   complete setups. Bulk sync skips accounts whose first sync has not started;
   expired accounts keep their expiry rules. Clear the selection to switch tabs.
   **Addons** contains the group editor; **Sync status** shows publication progress.
   Accounts moved
   from another group use the new group's shared addons and keep account-only
   addons. A saved group with automatic sync starts once the group is published
   and membership is set. You can also use
   the account's **Group** tab or **Select → Bulk actions → Assign group** on Accounts.
   Open one member and customize an addon: the other members and the
   shared group must remain unchanged. Publish another group change; untouched
   addons follow it while that account's customizations remain. **Use group
   version** resets an individual addon override. Leave the group and confirm the
   complete saved setup is retained for independent management. Pause and resume
   from **Settings → Account sync** to check that changes wait while paused.
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
   To show an expiry card, open **Settings → Account sync → Expiry notice in
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
email. For an account marked **Sync not started**, save its group to start automatic sync
once the group is published and a membership is set. Individual setups start from **Sync & access**.

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

## API integration and account attention

Use **Settings → API integrations** to create a dedicated test key. Select only
the required permissions. Verify `/api/v1/me`, staged account creation, exact retry,
membership edits and operation polling as described in [API.md](API.md). Revoke the
key and confirm it no longer authenticates. Keep real customer credentials out of
test fixtures and plain JSON config files.

On Accounts, check the 7/30-day expiry filters, expiry sorting and Needs attention.
The latter shows incomplete setup, failed/retrying sync and delayed jobs. Backup
warnings refer to application archives; they do not claim an off-server backup.

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
