# Group implementation slices

Implement against DECISIONS.md and the release gates. Provider writes remain off
until the single-writer service and every legacy-writer gate are integrated.

## G1: configuration and assignment

- Keep full addon descriptors, enabled/protected flags, manifests, catalog choices,
  custom metadata, order, and extension fields. Share bounded JSON/descriptor
  validation between browser and backend. Maximum 200 descriptors / 2 MiB per list
  is an initial defensive limit, not a provider limit.
- Configured URL path/query case is significant. Different URLs with the same
  manifest ID are allowed. Duplicate effective URLs within or across group/personal
  layers produce a conflict; do not silently choose one set of credentials.
- Draft creation/save and reads are manager-scoped. Encrypt group names, drafts,
  and personal lists using the existing record-bound envelopes. Save requires an
  expected version and retry key. Draft editing never queues provider work.
- Safe mode inherits the owner default unless explicitly overridden; changes apply
  on the next sync. Draft edits do not change the published addon configuration.
- Bulk assignment is all-or-nothing, max 200 users per request, with a version for
  each user. Staged users may be assigned a draft without being activated. Active
  transfers require a published destination; active unassignment is blocked.
  Offboarding records cannot be transferred or given new personal configuration.
- Personal edits and active transfers advance account policy and queue requested
  work in the same transaction. Staged edits remain job-free. These endpoints do
  not log in, register, fetch a manifest, or touch a provider collection.

## G2: publication and rollout persistence

- A reviewed draft becomes an immutable revision. Preview binds group version,
  affected cohort, and relevant account policies; stale previews are rejected.
- Validate resolved manifests and every affected personal-layer collision before
  publication. Failed/unreadable/missing configuration is never an empty list.
  An intentionally empty effective configuration requires an explicit destructive
  choice. Structural validation alone is not proof a remote manifest is reachable.
- Commit revision, deployment cohort, account policy advances, and queued jobs
  together for the intended 40–100-member scale. Measure 100/1,000-user transactions
  before deciding whether resumable expansion is warranted; never perform network
  requests inside this transaction.
- Include expired users as suspended targets, not active installs. Lifetime users
  receive ordinary group work. Staged users inherit the revision upon later
  activation; offboarding is independent and cannot be cancelled by publication.
- Duplicate publication retries create one rollout. Later publication, transfer,
  renewal, and personal edits fence stale completion. Progress derives from the
  recorded cohort and its jobs, not mutable current group membership alone.

## G3: authoring UI and execution integration

- Reuse the source application's manifest URL, metadata/catalog, enabled, protected,
  and order editing capabilities. Do not replace these with a reduced URL-only UI.
- Show group/personal ownership and collisions, first-sync safe-mode choices, draft
  versus published state, and previewed changes. Group publication schedules all
  eligible members; the browser never performs a per-user provider write loop.
- Connect trusted manifest validation, effective configuration/suspension, encrypted
  snapshots, bounded single-writer execution, and exact remote verification before
  enabling activation. Finish indexed expiry scanning and overdue status as part
  of this integration. Expiry never removes retained descriptors.

### G2 transaction and validation protocol

Publication preparation validates manifests through a trusted injected adapter
outside a database transaction, then rechecks the draft version and cohort. It
returns a short-lived encrypted receipt bound to owner/group, draft digest, group
version, cohort policies/targets, safe-mode default, and validation time. Missing
validation adapter means publication is unavailable, not implicitly validated.
The HTTP path is enabled only with the server's trusted adapter; authoring UI and
provider execution remain separate increments.

Commit uses the existing request-idempotency transaction. A committed retry replays
before checking receipt age, so an expired preview cannot hide a successful prior
publication. New work rejects stale/invalid receipts, changed cohorts, conflicts,
and unconfirmed empty/all-disabled drafts. Snapshot at most 1,000 group members in
one bounded transaction for this implementation; report the limit explicitly.

A changed publication advances the group version/revision and each active member's
policy/record version, persists all jobs and an encrypted cohort, and audits the
deployment atomically. Staged/offboarding members receive no publication jobs.
An unchanged published addon configuration is a no-op, not an automatic drift
rewrite; explicit reconciliation is a separate operation. Progress reports the
recorded jobs, and does not present a stale pending job as the current policy.

## Tests required for each slice

Run common contracts on SQLite and real PostgreSQL: tenancy, encryption, exact URL
identity, descriptor fidelity, optimistic concurrency, idempotency, stale previews,
mixed staged/active/expired/lifetime/offboarding cohorts, all-or-nothing rollback,
and zero provider IO while passive. Add HTTP/client tests and synthetic browser
rehearsals with no paying credentials. Record actual provider/device/soak evidence
separately; none is established by these storage tests.

## G1 implementation evidence

The encrypted draft, personal-addon, and bulk-assignment repository methods and
authenticated HTTP routes are implemented. No group-publication route, group UI,
or activation path is enabled in this slice. Existing schema tables are reused;
there is no new schema migration.

HTTP surface: `GET/POST /api/managed/groups`, `GET /groups/:id`,
`POST /groups/:id/draft`, `POST /accounts/assign-group`, and
`GET/POST /accounts/:id/personal-addons` (all under `/api/managed`). Responses omit
passwords; authorized configuration reads contain the requested addon URLs and
must not be logged. Group list summaries omit configured URLs.

Local verification: 160 passed, 50 PostgreSQL cases reserved for hosted CI, zero
failures. Typecheck, lint and build passed. Thirteen common group cases run on both
engines; five pure descriptor cases and two HTTP scenarios cover config fidelity,
URL collisions, cross-owner denial, exact versions, transaction failure, restart,
and zero provider calls. The 100-user passive assignment took 43–44 ms in isolated
local runs and 162 ms while the other verification processes competed for CPU.
These are single synthetic samples, not p95 measurements or provider throughput.

G1 also passed all five hosted jobs, including 50 real PostgreSQL cases, in
[run 35485143282](https://github.com/hossman39/AIOManager/actions/runs/35485143282).

## G2 persistence evidence

Internal preview/publication/deployment methods implement the protocol above.
The initial persistence checkpoint used injected validation only; the subsequent
adapter/HTTP increment is described below. No provider collection is read or written.
Published payloads are checked against their authenticated digests when read.

Local verification: 181 passed, 70 PostgreSQL cases reserved for hosted CI, zero
failures. Typecheck, lint, and build passed. Twenty publication contract cases
run on both database engines; an additional file-backed SQLite restart test
proves an already committed publication replays after preview expiry, even when
the restarted repository has no validator. Tests cover stale drafts/cohorts,
expiry transitions, lifetime, empty-publication consent, personal conflicts,
concurrent delivery, superseded progress, and rollback after a late failure.

Isolated synthetic preview plus publication samples were 12-16 ms for 40 users,
19-20 ms for 100, and 226-238 ms for 1,000. They use an immediate fake validator
and no provider IO: these are not p95, VPS, or remote rollout measurements.

G2 persistence also passed all five hosted jobs, including 70 PostgreSQL tests,
in [run 35486172593](https://github.com/hossman39/AIOManager/actions/runs/35486172593).

## Manifest adapter and HTTP/client increment

The bounded read-only [manifest adapter](MANIFEST-VALIDATION.md) is now connected
to authenticated resolve/preview/publish/progress routes and the typed browser
client. Publication is available as a queued database operation; activation and
provider collection writes remain disabled. Staged users are never activated by
publication, and queued work is not presented as verified.

Routes added under `/api/managed`: `POST /manifests/resolve`,
`POST /groups/:id/preview`, `POST /groups/:id/publish`, and
`GET /deployments/:id`. Preview cancellation aborts its network read. A successful
publication can be replayed after restart without fetching manifests again.

Authoring UI, safe-mode projection against a fresh provider read, and every
existing writer's gate remain required before enabling any account.
