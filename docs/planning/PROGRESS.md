# Implementation progress

Updated 2026-09-22. The owner authorized finishing release cleanup and deployment,
with Android TV acceptance in the live environment and whole-server backups deferred.
No paying accounts or production database have been modified during this increment.
The deployment target/access is still needed; publishing an image is not a VPS deployment.

## Release preparation: 2.0.0

Accounts now offers expiring-in-7/30-days filters, expiry sorting and Needs attention
for incomplete setup, failed/retrying jobs and delayed work. The current-policy job
summary is read with the inventory, avoiding per-account requests. Quiet refreshes
pause while editing or selecting. Application-backup status distinguishes disabled,
never recorded and over-26-hours-old archives. Server-wide backup infrastructure
remains outside this increment.

Settings includes API integrations with owner-scoped, revocable, expiring keys.
The new `/api/v1` supports account staging/explicit external-reference linking,
memberships, group assignment/publication, addon settings, first-sync review,
sync, password repair and verified offboarding. Operation history and action-scoped
receipts support restart/lost-response recovery. Addon URLs, saved credentials and
removal require separate permissions. Keys cannot manage keys or resume global sync.
Migration 9 and encrypted backups include key digests and external references.
The API does not register Stremio identities, buy IPTV/debrid/TiviMate services,
or implement billing. TV Box Manager's client integration is a separate step.
See [API.md](../API.md) and its generated OpenAPI document.

Deployment/update references use the fork, image selection requires a tested SHA
tag/digest, the footer shows version/build identity, and the README/deployment guide
describe the managed workflow. The existing upstream author credits are retained.

Local validation: 358 tests pass, 144 PostgreSQL cases await hosted CI; typecheck,
lint and build pass. New coverage exercises key hashing/scopes/expiry/revocation,
cross-owner denial, exact/concurrent retries, token rotation, restart recovery,
API-driven activation/expiry/renewal/removal, transaction rollback, rate limits,
backup restoration, current-policy job visibility and expiry-window boundaries.
All provider traffic in those checks is synthetic.

An isolated browser rehearsal confirms key creation and permissions, connection
discovery and dated membership via the issued key, key revocation, the unsaved-key
navigation guard, expiry filtering/sorting and Needs attention. Account and API
screens fit a 390px viewport without horizontal overflow. Hosted and deployment
evidence will be recorded separately after those actions complete.

## Earlier account editing checkpoint

Account cards now have direct editors for display name, group and membership.
The account list has a **Select** button, selection across filters/pages and
**Bulk actions** for expiry/lifetime, group assignment, removal from groups and
sync. Cards are paged at 12 per page, with up to 200 selected accounts. The account
and group screens share the same update dialog and backend transaction helpers.
Accounts whose first sync has not started stay staged.

Names are updated in the encrypted server record with account version checks and
exact retries. The saved Stremio identity, password, setup and policy version stay
intact, and renaming does not enqueue a provider write. Bulk membership and sync
work across multiple groups and individual accounts; every selected version and
owner is checked before any change.

Global sync controls, safe-mode defaults and expiry notice settings now live in
**Settings → Account sync**. Account links and guidance point there, and old
`/accounts/sync-settings` bookmarks redirect while preserving the manager query.
Settings tabs use router navigation so unfinished managed edits are guarded when
switching tabs as well as leaving Settings.

Local validation: 346 runnable tests pass, and all 140 PostgreSQL contracts pass
in hosted CI. Typecheck, lint and build pass. Added contracts cover mixed individual/group
bulk changes, invalid selections, rollback, retries, encrypted names, unchanged
credentials and policy versions, stale caches, and HTTP persistence after restart.

An isolated browser rehearsal used 24 synthetic accounts. It edited a name with
exact retry after a lost response, changed a dated membership to Asia/Kathmandu,
moved an account in/out of a group, selected accounts across pages and filters,
updated mixed account memberships, and synced an active account while skipping a
staged one. It assigned and detached 21 accounts in bulk while retaining their
setups. Settings pause/resume, notice persistence, old-route redirection and the
unsaved-edit navigation guard passed. Account cards, selection controls, the bulk
dialog and Settings fit a 390px viewport without horizontal overflow. Provider
traffic in this rehearsal was entirely synthetic.

The dedicated local test instance preserves its database and encryption key and
serves `index-D7W-ec1z.js` on port 1611. A pre-update database copy retaining
encrypted records is outside version control. The restarted writer is ready,
sync is running, and the expiry scan is current. No pending, running or retrying
jobs remained at the local check.
Code checkpoint `15cf2c2` passed all five hosted checks in
[run 35718346453](https://github.com/hossman39/AIOManager/actions/runs/35718346453):
Windows/Linux validation, PostgreSQL contracts, and AMD64/ARM64 containers.

## Earlier bulk group-members checkpoint

Open groups now separate **Addons**, **Members** and **Sync status** into tabs.
Members use a compact list with name/email search, status filters and 10 rows per
page. Checkboxes retain selection across pages and filters; **Select all matching**
supports up to 200 selected accounts. **Add members** opens a separate, searchable
and paged dialog instead of expanding the group screen. Account links remain
available for individual management.

**Bulk update** appears when members are selected. It supports a common dated or
lifetime membership, moving to another group, keeping members as individual
accounts, and syncing selected accounts whose first sync has started. Dated
memberships default to `America/New_York` and accept other named timezones with
explicit handling of clock changes. Expired accounts retain suspension rules;
staged accounts are never activated by a bulk action. Removing group membership
preserves the account's complete addon setup and membership.

Bulk membership and sync requests validate all selected account versions, group
membership and ownership before changes in one transaction. Assignment uses the
same source-group check. Exact retries preserve the original request and do not
repeat updates; stale selections require a reload. Individual membership and sync
use the same transaction helpers as the new bulk operations.

Local validation: 340 runnable tests pass, and all 136 PostgreSQL contracts pass in
hosted CI. Typecheck, lint and build pass. New shared contracts cover timezone
cutoffs, clock changes, concurrent retries, ownership, stale/moved members,
offboarding, atomic rollback, staged accounts and expired sync targets.

The isolated browser rehearsal loaded 128 synthetic accounts and a 105-member
group. It checked selection across list pages and search queries, bulk expiry with
an exact retry after a simulated lost response, moving/removing selected members,
syncing an expired active member while skipping a staged member, and adding
accounts selected across dialog pages. The member list and both dialogs fit a
390px viewport; selecting all 103 remaining members kept only 10 rows rendered.
No real provider requests were used in these tests.

The user accepted one-click publishing in the previous build. The Android TV
notice remains deferred until the live server has a reachable HTTPS address.

The dedicated local test instance preserves its database and encryption key and
serves `index-BH54vGo4.js` on port 1611. A pre-update SQLite copy retaining encrypted
records is outside version control. The restarted writer is ready, the expiry scan
is current, and no pending, running or retrying jobs remained at the local check.
Code checkpoint `caae947` passed all five hosted checks in
[run 35685554151](https://github.com/hossman39/AIOManager/actions/runs/35685554151):
Windows/Linux validation, PostgreSQL contracts, and AMD64/ARM64 containers.

## Earlier group-publishing checkpoint

Groups now use a single **Publish changes** action. It validates the current edits,
saves the name/addons/protection settings, records an immutable revision and queues
the current eligible members in one transaction. Failed validation or any later
database failure leaves the saved group unchanged. Exact retries return the original
result even after restart or a manifest outage. Older draft/preview APIs remain
compatible, but those separate steps are no longer presented in the group editor.
Protection-only changes also queue sync; renaming an unchanged setup does not.

An open group now shows its members, links to individual accounts, and an **Add
members** picker with name/email search. The picker reads all account pages,
excludes existing members and accounts being removed, and supports up to 200
selected accounts per assignment. Moving from another group is labeled explicitly.
Group settings replace matching addon overrides while account-only addons remain.
Accounts whose first sync has not started remain inactive; an unpublished group
cannot receive accounts whose sync has started. Existing assignment version checks
and retry handling are retained.

Local validation: 331 tests pass; all 129 PostgreSQL contracts pass in hosted CI.
Typecheck, lint and build pass. New shared contracts cover atomic publication,
mixed account states, expiry edits, validation/cancellation failures, rollback,
concurrent requests, retries, empty configurations, ownership and protection edits.
The HTTP test confirms persistence and exact replay after restart.

An isolated browser walkthrough published edits with one click, added an individual
account from inside its group, and moved both an expired active member and an
inactive member to another group. Simulated lost responses for assignment and
publication both recovered through exact retries without duplicate work. The
member picker fits a 390px viewport without horizontal overflow. Provider traffic
in this rehearsal uses synthetic fixtures.

The user accepted renewal, individual overrides, group updates and group deletion
in the previous build. The manual timezone check was deferred for lack of time;
automated timezone contracts remain green. The Android TV notice check is deferred
until the live server has a reachable HTTPS address. The current loopback notice
URL is appropriate only for the local PC and was not changed in this increment.

The dedicated local test instance preserves its database and encryption key and
serves `index-DE-SB2cr.js` on port 1611. An encrypted pre-update SQLite copy is
retained outside version control. The restarted writer is ready, the expiry scan
is current, and no pending, running or retrying jobs remained at the local check.
Code checkpoint `d11cccf` passed all five hosted checks in
[run 35682902018](https://github.com/hossman39/AIOManager/actions/runs/35682902018):
Windows/Linux validation, PostgreSQL contracts, and AMD64/ARM64 containers.

## Earlier selective-expiry checkpoint

Expiry now follows per-addon **Disable on expiry** choices saved in the encrypted
group revision. Publishing applies the choices to already expired members too;
saving a draft alone remains passive. Existing configurations default to disabling
all addons until explicitly changed. A **Keep browsing addons** shortcut retains
metadata/catalog/subtitle providers without a stream resource. Combined providers
stay selected for disabling; the owner can adjust every checkbox.

Group expiry choices take precedence over an individual's customization of the
same addon. Individual and account-only addons also support expiry choices, and
leaving/deleting a group preserves them. Suspension retains enabled, unchecked
addons plus the optional renewal notice; renewal restores saved enable preferences.
Offboarding still requires a verified empty collection. Unreadable group policies
retain the fallback that removes access rather than guessing which addons to keep.

The account screen compares live Stremio results against the selected expiry setup
and no longer calls retained catalogs an enforcement failure. The default notice
message is “Your box has expired. Please reach out to your contact to renew.”
Existing customized messages are preserved. Notice setup remains in Sync settings
and requires an address reachable from the Stremio device.

Local validation: 322 tests pass. Typecheck, lint and build pass. New shared contracts exercise browsing/subtitle
retention, disabled preferences, expiry-only publication, personal overrides,
drift repair, group deletion, renewal, full removal, protected no-write acceptance,
invalid readback rejection and unreadable-policy fallback.

An isolated browser walkthrough published the browsing shortcut to an already
expired member, then verified Cinemeta plus the renewal notice with the streaming
addon absent. The episode-source endpoint returned the new message. Group and
account expiry controls fit a 390px viewport without horizontal overflow.
The local test instance preserves its database/key, serves `index-DT9XSvYD.js`
on port 1611, and has an encrypted pre-update SQLite copy outside version control.
Its notice is still unconfigured; the acceptance steps include enabling it with a
reachable address. No real provider writes were used for this increment's tests.
Checkpoint `cdf2425` passed all five hosted checks in
[run 35674634131](https://github.com/hossman39/AIOManager/actions/runs/35674634131):
Windows/Linux validation, all 122 PostgreSQL contracts, and AMD64/ARM64 containers.
The restarted local writer is ready, its expiry scan is current, and no pending,
running or retrying jobs remained at the final local check.

## Earlier expiry-notice checkpoint

Expiry status now distinguishes membership expiry, pending enforcement and verified
disabling. The account's **Check Stremio** action lists the provider's actual addons
and the checked email; saved switches explicitly describe renewal preferences.
Live comparison normalizes outgoing manifests so custom names/disabled preferences
do not create false drift. Native managed transport rejects missing sessions before
Stremio can return anonymous defaults.

Group deletion is owner scoped, versioned, transactional and retry safe. Members
become individual accounts with effective setups preserved, including overrides,
disabled preferences and protected entries. Revisions and audit history remain;
deleted groups disappear from selection. Active/expired/offboarding work retains
the existing version fencing and durable verification.

Migration 8 stores encrypted manager expiry-notice settings and an opaque public
notice token. The optional addon replaces normal addons on expiry, provides a
Home/Discover card and movie/series source notice, and is removed on renewal or
offboarding. Its public routes expose only the chosen notice and renewal link.
The system notice is excluded from saved renewal configuration. The installation
address must be reachable from the Stremio device; local loopback is for this PC.

Local validation passes 315 tests (117 PostgreSQL contracts reserved for hosted
CI), typecheck, lint and build. HTTP tests cover public protocol responses, PNG,
CORS, authentication, invalid settings and escaped fallback HTML. Shared runtime
contracts cover repeated suspension, settings changes, group deletion while expired,
renewal and notice removal. Backup/restore preserves encrypted notice settings.
An isolated browser rehearsal verified saving the notice, an installed list of
only the notice, deleting a two-member group without losing accounts, and renewal
restoring the normal addon.

Read-only diagnosis of the dedicated real test instance confirmed its activated
account's Stremio identity and email, and four installed addons (AIOMetadata,
Cinemeta, OpenSubtitles v3 and Streams). The second account was still staged.
At that check the first account had been renewed. Device-side display/cache has
not been verified; no real Stremio account was changed by the diagnostic reads.
The local test instance now runs migration 8 with the original database/key and
serves `index-DJMCF_LS.js` on port 1611. The page, script, stylesheet and new notice
settings endpoint return 200. A native API read after restart confirms the four
installed addons match the saved setup. Notice display remains opt-in until its
reachable installation URL is configured. Both the account view and notice form
fit a 390px viewport without horizontal overflow; no browser console errors were
reported. A pre-upgrade encrypted SQLite copy is retained outside version control.
Code checkpoint `8c3f721` passed all five hosted checks in
[run 35669330115](https://github.com/hossman39/AIOManager/actions/runs/35669330115):
315 tests on both Windows and Linux, all 117 PostgreSQL contracts, and AMD64/ARM64
container checks. The local writer's scan is current and no pending/retrying work
was left by this update.

## Earlier individual-account checkpoint

Individual management is restored. Accounts now uses summary cards with an
**Open account** link; each detail page contains addon cards, membership, an
optional group, and sync/access controls. Groups and global sync settings are
separate pages. The oversized inventory editor is replaced, and the header no
longer covers account titles. This information hierarchy follows the reviewed
Slicksync Users/Groups pages at the pinned baseline; no reference code was copied.

Migration 7 adds encrypted account overrides and an explicit saved-setup marker.
An account can preview and activate its own setup without a group. Account edits
override only matching group entries; untouched entries follow later publications.
Leaving a group retains the complete saved setup. Explicit account changes can
customize/reorder protected entries, while expiry still disables everything and
renewal retains the saved preferences. All provider mutations retain the existing
version checks, snapshots, write gates, durable jobs and readback verification.

Local validation passes 310 tests, with 114 PostgreSQL contracts reserved for CI,
plus typecheck, lint and build. Coverage includes the full independent-account HTTP
lifecycle, optional group joins, isolated overrides, later shared publications,
detachment, Tokyo expiry/renewal, client request boundaries, additive migrations,
and encrypted backup/restore of overrides. Browser checks cover individual addon
editing, manifest installation, catalog changes, protected Cinemeta options,
reordering, membership, first sync without a group, group joins and publication.
The local test instance has upgraded to migration 7 with its original accounts
and key retained; an encrypted SQLite copy was taken before the upgrade.

Code checkpoint `6e3e00c` passed all five hosted jobs in
[run 35666047415](https://github.com/hossman39/AIOManager/actions/runs/35666047415):
310 local tests on Windows/Linux, all 114 PostgreSQL contracts, and AMD64/ARM64
container checks. The final isolated browser rehearsal confirms that a shared
publication reaches the unchanged member while the customized member keeps its
own name; group removal retains both addons; a Tokyo cutoff suspends the account
with verified readback; lifetime renewal restores it. A 390px mobile viewport has
no horizontal overflow. The typing/polling regression was reproduced and fixed
with a stable dialog descriptor. Unsaved membership navigation is guarded.
The final local test build serves `index-DhkurzhQ.js` on port 1611 with its original
database/key and schema 7; the page and both referenced static assets return 200.

## Earlier unified inventory checkpoint

Accounts is now the single account workspace. Existing browser accounts connect
automatically to their server records by owner and email; normal account addition
uses the same path. Existing managed settings and saved credentials are preserved.
Accounts lacking saved credentials stay visible with a completion action. The
separate Managed users tab is removed, and old links redirect to Accounts.
External import is optional; no export/import round trip is required.

Migration 6 retains encrypted-identity lookup links after verified removal, so
stale browser copies cannot recreate an account. The client also removes those
copies and their old automation rules. Backups include the links. Connection
alone never activates an account or queues provider work. The suite now passes
298 local tests, with 111 PostgreSQL cases reserved for hosted CI; typecheck,
lint and the production build pass. Browser upgrade testing confirms an old
account and its imported counterpart become one row with existing settings.
The isolated browser also verifies fresh account addition, a London expiry,
first-sync activation/readback, verified removal with cache cleanup across reload,
and a 390px layout without page overflow. Auth-key accounts expose the saved-login
completion action. Checkpoint `f4f5fd7` passed all five hosted jobs in
[run 35655487090](https://github.com/hossman39/AIOManager/actions/runs/35655487090),
including all 111 PostgreSQL cases and both container architectures. A stale
membership-save notice is cleared when opening the next account editor.
The saved-login completion rehearsal also exposed an existing account-store bug:
credential edits refreshed the token without retaining the new email/password.
Verified edits now persist the exact password encrypted, and the edit form can
complete accounts with no known email. Two store regressions cover successful
completion, unchanged credentials on a rename, and a rejected login leaving the
original account intact. A dropped connection response is recoverable with Retry
account setup and creates no duplicate account.
Final code checkpoint `596b125` passed all five hosted jobs in
[run 35656501764](https://github.com/hossman39/AIOManager/actions/runs/35656501764):
298 tests on Windows/Linux, all 111 PostgreSQL cases, and AMD64/ARM64 container
checks. The final browser rehearsal completes an auth-key account in the same
row and retains its saved login across reload; opening its next editor clears
the completed membership notice. The local test server is healthy on port 1611
with migration 6 and the final assets, using its existing database and key.

The first account-add acceptance report exposed an upstream vault initialization
bug: registration accepted a short password, claimed the remote identity, swallowed
local setup failure, and opened the workspace without an encryption key. Fresh
logins to identities without a salt could enter the same state. Registration now
validates the password and publishes its actual new vault salt; setup failures
propagate. The workspace requires a key, and authenticated login repairs missing
metadata without resetting existing encrypted data. Silent unlock failures also
stop sync. Nine store integration regressions pass, bringing the local suite to
285 passing tests (105 PostgreSQL cases run separately in CI). Typecheck, lint and
build pass. An isolated browser reproduced the old failure, then recovered the
same kind of identity with its original password, added a synthetic Stremio account,
and retained the account and key across reload. The local test server serves the
updated assets; refresh and unlock with the existing manager credentials.
Vault fix `52a00c3` also passed all five hosted jobs in
[run 35556520045](https://github.com/hossman39/AIOManager/actions/runs/35556520045).

Activation with first-sync review, native Stremio transport, deployment-wide writer
ownership, legacy proxy/Autopilot gates, pause/resume, retries, login repair,
scheduled expiry, recurring suspension checks, an Expired view, renewal and
verified offboarding are connected. Memberships support selectable named timezones;
`America/New_York` is the default. Daily encrypted backups and an offline empty-target
restore tool are included. See [MANAGED-RUNTIME.md](MANAGED-RUNTIME.md) and the
[testing walkthrough](../TESTING-MANAGED.md).

Local Windows validation: 275 tests passed, plus the subsequent offline restore CLI
rehearsal. Typecheck, lint and production build passed. Both production dependency audits
report zero findings. New tests include the native HTTP lifecycle, response/body
timeouts, cross-process writer exclusion, authenticated backup restore/tamper and
retention, plus the existing 100-account and encrypted restart recovery contracts.
Browser checks confirm the New York default, selecting/saving/reloading Kathmandu,
rejection of a New York spring gap, and explicit fall-fold choices. At 390px, the
page has no horizontal overflow; activation, verified sync, a simulated lost
sync response and same-request replay, lifetime renewal, expired filtering and
verified removal passed. Two stale status messages found during rehearsal were
corrected. The restore CLI was also executed against a fresh directory, then the
restored application was booted and its authenticated account read successfully.

Final testing checkpoint `ad0373c` passed all five hosted jobs in
[run 35513062652](https://github.com/hossman39/AIOManager/actions/runs/35513062652):
276 tests each on Windows and Linux, all 105 PostgreSQL cases, and AMD64/ARM64
container smoke checks. Typecheck, lint, production builds and dependency audits
also passed. This includes the offline restore CLI rehearsal and final status
message corrections. No image publication or production deployment ran.

Remaining acceptance is on dedicated Stremio accounts/Android, the owner's actual
export and VPS, and the production soak/release gates. The test instance has a
separate database/key and starts new managers paused. Historical increments below
describe the boundaries when they were recorded, not the current runtime.

## Completed locally

- Reconciled the plan with the owner's decisions, including individual addons, exact New York expiry, credential-only migration, preserving new-account creation, and no blanket active-account drift enforcement.
- Corrected expiry to **disable, not delete**. Retain saved addon descriptors, URLs, customization, order, protection, and manual enabled preferences. Upstream's enabled-only serializer omits disabled addons from Stremio's active collection.
- Added a pure suspension projection and tests for disable-all, renewal, personal/protected addons, remote refresh, repeated transitions, and serialized configuration retention. It is not connected to a timer, database, or UI yet.
- Added a passive email/password parser for current 2.0.0 Settings exports and legacy account arrays/envelopes. No imports of source addons, auth tokens, or history; no registration, login, persistence, or provider write. Missing passwords and conflicts are explicit.
- Added 46 unit/compatibility tests and typechecking of the tests. Existing login/registration, custom metadata/catalogs, protected addons, disabled-state retention, and configured URL identity have initial regression coverage.
- Resolved the upstream baseline's two lint errors and seven warnings through small regex/const/dependency/unused-variable fixes; no lint rules were weakened.
- Added a read-only quality workflow for Windows/Linux using pinned action commits. The backend foundation passed hosted Windows/Linux, PostgreSQL, and AMD64/ARM64 container checks in [run 35472588828](https://github.com/hossman39/AIOManager/actions/runs/35472588828). No deployment step ran.
- Added versioned managed schema migrations, strict owner/record-bound encrypted envelopes, a stable wrapped lookup key, authenticated staging APIs, encrypted import reports, and atomic request/batch deduplication. Preview and staging perform no provider calls and create no runnable jobs.
- Added internal durable job claims, priority, pause checks, lease fencing/recovery, encrypted per-attempt snapshots, exact collection verification guards, and expiry/renewal supersession. This is persistence logic, not an enabled provider worker or expiry scheduler.
- Added regression coverage for legacy sync claim races, read-side migration races, and preventing deletion/reclaim of a manager identity that owns managed data.
- Added explicit dated/lifetime membership controls, shared New York cutoff resolution, additive migration 2, versioned retry-safe saves, and transactional renewal-job scheduling. Imported unset memberships remain distinct. Staged edits remain passive; no scheduler/provider writer is enabled. See [MEMBERSHIPS.md](MEMBERSHIPS.md).
- Added encrypted group draft/personal-addon APIs and atomic bulk assignment with shared descriptor validation. Existing customization and configured URL case are retained; collisions require explicit resolution. See [GROUPS.md](GROUPS.md).
- Added group publication persistence: expiring previews, immutable revisions, atomic cohort/job creation, retry-safe replay, and recorded deployment progress. The read-only manifest adapter, authenticated HTTP routes and typed client are connected; provider execution remains disabled.
- Added group authoring, preview/publish, passive bulk assignment and personal-addon editors. Metadata, catalogs, Cinemeta choices, exact URLs, enabled/protected flags and order remain editable. Retry freezes the original operation; stale edits require reload. A single navigation guard covers independent managed editors, pending imports/memberships, browser history and explicit logout. See [GROUP-EDITOR.md](GROUP-EDITOR.md).
- Added owner-scoped discovery of the published group's recorded rollout, including encrypted restart recovery. UI selection/reload does not rely on a remembered publish response; missing published data fails closed.
- Added an internal injected-provider execution engine, encrypted plans committed with snapshots/write intent, bounded requests/retries, exact readback, and restart reconciliation. Indexed expiry observation now persists suspension through clock rollback; renewal explicitly clears it. See [WORKER-FOUNDATION.md](WORKER-FOUNDATION.md). The application still starts no managed writer or expiry timer.

## Current local evidence

The membership checkpoint passed all hosted checks in [run 35484284157](https://github.com/hossman39/AIOManager/actions/runs/35484284157),
including its 37 PostgreSQL cases. The same increment passed 139 local tests
with those PostgreSQL cases assigned to hosted execution. Isolated synthetic browser
rehearsals cover credential staging, lifetime/date saves, lost-response retry,
reload, and mobile layout; see [MIGRATION-UI.md](MIGRATION-UI.md) and
[MEMBERSHIPS.md](MEMBERSHIPS.md). Typecheck, lint, and build pass. Both production
dependency audits report zero known findings. Synthetic 100-account staging/inventory and
file-backed account/job/snapshot restart recovery pass; these are not provider
throughput or real-device measurements.

G1 group storage passed 160 local tests and all five hosted jobs, including 50
PostgreSQL cases, in [run 35485143282](https://github.com/hossman39/AIOManager/actions/runs/35485143282).
G2 publication persistence passed 181 local tests and all five hosted jobs,
including 70 PostgreSQL cases, in [run 35486172593](https://github.com/hossman39/AIOManager/actions/runs/35486172593).
Manifest/HTTP/client evidence and remaining integration work are in
[GROUPS.md](GROUPS.md). A custom sync-server path mismatch in the managed client
was also corrected and covered by a regression test.

The manifest/HTTP/client increment passed 211 local tests and all five hosted jobs,
including 70 PostgreSQL cases, in [run 35487159436](https://github.com/hossman39/AIOManager/actions/runs/35487159436).
Typecheck, lint, build and both production dependency audits passed. It adds no provider writer or activation endpoint. See
[MANIFEST-VALIDATION.md](MANIFEST-VALIDATION.md) for the read-only boundaries.

The authoring/navigation/recovered-progress increment passes 225 local tests,
with 72 PostgreSQL cases reserved for hosted execution. Synthetic browser checks
cover metadata/catalog retention, protected/disabled entries, bulk assignment,
group/personal lost-response replay, stale edits, empty publication consent,
reload, lifetime saves, navigation guarding and a 390px editor layout. No paying
accounts or real addon/provider services are used. Code checkpoint `2752011`
also passed all five hosted jobs, including its 72 PostgreSQL cases, in
[run 35493646398](https://github.com/hossman39/AIOManager/actions/runs/35493646398).
No image publication or production deployment ran.

The execution/expiry foundation passes 256 local tests, with 95 PostgreSQL cases
assigned to hosted execution. Typecheck, lint, build and both production dependency
audits pass (zero audit findings). Coverage includes encrypted execution-plan
restart recovery, lost responses, aborts beyond a lease, expiry/renewal races,
clock rollback, all Cinemeta option combinations, and a synthetic 100-account
scan/execution cohort. The existing build warnings remain. No dependency change,
live provider call, activation, scheduler startup or deployment is included. See
[WORKER-FOUNDATION.md](WORKER-FOUNDATION.md) for the integration boundary.
Code checkpoint `d3440b5` passed all five hosted jobs, including 95 PostgreSQL
cases and both container architectures, in
[run 35509002178](https://github.com/hossman39/AIOManager/actions/runs/35509002178).
No image publication or production deployment ran.

## First-increment evidence (historical)

Local Windows / Node 24.14.0 / npm 11.9.0:

| Check | Result |
| --- | --- |
| `npm test` | 46 passed, 0 failed; provider transport mocked |
| `npm run typecheck` | Passed, including new test sources |
| `npm run lint` | Passed, zero warnings |
| `npm run build` | Passed; existing large-chunk/dynamic-import and outdated Browserslist warnings remain |
| Dependency change | Pinned dev-only `tsx` 4.23.13 and its esbuild tree; no existing resolved package version changed |

The first lockfile regeneration removed three stale packages absent from the existing manifest (`@tanstack/react-virtual`, `@tanstack/virtual-core`, `glass-refraction`). Subsequent targeted dependency and backend changes are recorded in BACKEND-FOUNDATION.md; its current production audit supersedes the original dependency counts. No bulk force-fix was used.

## Prior checkpoint handoff (superseded by the testing increment above)

1. Verify each new increment in hosted CI. Keep publishing manual/fork-owned; no image has been published. Dated/lifetime membership controls are implemented, not live expiry enforcement.
2. Integrate the tested execution engine with deployment-wide single-writer ownership, a bounded native provider adapter, shared budgets and every existing writer's ownership/expiry gate. The injected runner and job store do not by themselves authorize activation.
3. Connect activation to the tested migration, membership and group screens. Verify the owner's actual export locally; never request client passwords in chat.
4. Connect first-sync choices to the tested safe-mode/group/personal/Cinemeta projection, preserving existing customization, disabled preferences and deliberate new-account creation. The authoring screens record intent, not verified provider effects.
5. Connect indexed expiry observation and persisted suspension to startup/periodic polling, bounded expiry rechecks, an Expired view, and verified offboarding. No addon deletion is an expiry operation.
6. Prove backup restoration, provider/Android contracts, concurrent changes, restart recovery, and 40/100-account load plus soak behavior before selecting a live pilot.

The [verification plan](VERIFICATION.md) remains the release authority. These unit tests do not establish zero bugs, complete migration, durable expiry, or real-device behavior.
