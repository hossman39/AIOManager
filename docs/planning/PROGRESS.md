# Implementation progress

Updated 2026-09-21. The managed runtime is now connected in an isolated testing
candidate. No paying accounts, production database, or production deployment has
been accessed or modified. Branch checkpoints/CI do not authorize production rollout.

## Current testing increment

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
296 local tests, with 111 PostgreSQL cases reserved for hosted CI; typecheck,
lint and the production build pass. Browser upgrade testing confirms an old
account and its imported counterpart become one row with existing settings.

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
