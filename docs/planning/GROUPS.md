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

The next increment is G2 publication persistence. Trusted manifest fetching,
safe-mode projection against a fresh provider read, and every existing writer's
gate remain required before enabling any account.
