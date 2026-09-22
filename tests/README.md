# Application tests

Current release adds `integration-api.test.mjs`, the SQLite/PostgreSQL shared
`integration-contract.mjs`, and `account-health.test.ts`. These cover scoped API
access, recoverable account workflows and attention/expiry boundaries. All external
provider requests remain synthetic. See [API.md](../docs/API.md) for the public contract.

Run on Node 24.14.0 (the verified local runtime):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild better-sqlite3 --ignore-scripts=false
npm run typecheck
npm run lint
npm test
npm run build
```

The suite uses Node's built-in test runner and pinned `tsx` for TypeScript/path aliases, without upgrading Vite. `typecheck` checks application and TypeScript test code. CI uses Node 24.21.0 on Windows/Linux; local checks so far use 24.14.0. Hosted results must be recorded separately.

All credentials and addon URLs are synthetic. TypeScript provider tests import
`helpers.ts`, which rejects accidental fetch/http/https requests. Server tests
inject transports that reject provider calls; storage tests have no provider
transport. No Stremio accounts are created or modified.

## Boundaries

- `addon-compatibility.test.ts`: enabled-only payloads, saved disabled records, customization, protected addons, URL identity, Cinemeta options, and respecting ordinary client removals during refresh.
- `addon-suspension.test.ts`: expiry projection retains all configuration, suppresses every effective enabled flag, and lifts suspension without changing saved manual preferences. JSON round trips model serialization only, not database crash recovery.
- `account-auth.test.ts`: existing login/registration API contracts and failures; not an end-to-end onboarding/device test.
- `credential-import.test.ts`: passive credential allowlist, export envelopes, exact passwords, duplicate/conflict handling, redacted errors, and resource limits. It does not stage records or authenticate clients.
- `database.test.mjs`: native SQLite transactions, rollback, concurrent isolation, persistence, and PostgreSQL client-lifecycle contracts with a fake pool.
- `server-lifecycle.test.mjs`: isolated Fastify startup/shutdown, legacy encrypted sync, key loss/restart, and static-serving contracts. Only loopback listeners and synthetic temporary databases are used.
- `managed-crypto.test.mjs`: strict envelope parsing, tamper/ownership/purpose checks, key rings, and secret-preserving canonicalization.
- `managed-storage.test.mjs` / `managed-contract.mjs`: native SQLite migrations, owner scoping, atomic passive staging, repeated/concurrent import, credential conflict handling, and a synthetic 100-account inventory.
- `managed-api.test.mjs`: authentication, response redaction, size limits, cross-owner denial, passive staging, encrypted file-backed restart, and legacy identity claim/delete/read-migration races.
- `managed-client.test.ts`: browser credential allowlisting, auth/redirect/error handling, cancellation, membership response validation and exact retry/offset requests.
- `addon-config.test.mjs`: full descriptor/customization retention, exact configured URL identity, explicit collisions, invalid input, and count/byte/depth limits.
- `managed-addon-draft.test.ts`: immutable metadata/catalog/Cinemeta edits, protected removal, exact URL replacement and retained manual enabled flags.
- `managed-submission.test.ts`: cloned retry payload/key and explicit versus ambiguous failure classification. Browser rehearsals separately exercise the React controls.
- `managed-navigation.test.ts`: independent editor aggregation/cleanup and the installed router's push/replace/Back/Forward blockers. Actual DOM/focus/logout/mobile checks are browser rehearsals, not simulated by these unit tests.
- `managed-groups.test.mjs` / `managed-groups-contract.mjs`: encrypted drafts, personal addons, atomic 100-user passive assignment, published-only active transfers, tenancy, version conflicts, retry/restart, and rollback after injected failure. Published/enrolled fixtures here are synthetic internal state, not real provider enrollment.
- `managed-publication.test.mjs` / `managed-publication-contract.mjs`: atomic immutable revisions and rollout cohorts, trusted-validator boundary, stale/expired previews, explicit empty consent, mixed entitlement, rollback, concurrent delivery, superseded progress, file-backed replay, and synthetic 40/100/1,000-member publication. No real manifest adapter or provider writer is used.
- `managed-manifests.test.mjs`: bounded read-only manifest validation, safe addresses and pinned DNS, exact private-origin rules, redirects/rebinding, compressed/invalid/partial bodies, cancellation/deadlines/shutdown, global queue limits, and native loopback HTTP. Tests inject synthetic DNS/transports and never call addon hosts. Additional HTTP/client cases cover the connected publication API and replay after restart.
- `new-york-expiry.test.mjs`: calendar validation, spring gaps, repeated fall times, explicit offsets, and host-timezone independence.
- `managed-membership.test.mjs` / `managed-membership-contract.mjs`: additive schema upgrade, explicit lifetime versus unset, exact dated cutoffs, concurrent/idempotent edits, renewal/expiry jobs, saved configuration retention, and full transaction rollback.
- `managed-jobs.test.mjs` / `managed-job-contract.mjs`: durable claims, pause, lease recovery, per-attempt encrypted snapshots, atomic write intent, stale completion, expiry/renewal races, and file-backed restart. No remote worker is enabled by these tests.
- `managed-worker.test.mjs` / `managed-worker-contract.mjs`: injected-provider execution on both engines, exact persisted plans/readback, no-op/lost-response recovery, identity/data rejection, pause, policy races, retry/circuit/request bounds, monotonic expiry observation, migration/rollback, a synthetic 100-account cohort and file-backed restart. Stalled requests retain the local runner until settlement. No real network adapter or deployment-wide writer lock is enabled.
- `managed-projection.test.mjs`: group/personal layering, exact URLs, safe-mode anchors, saved disabled preferences, expiry retention, all Cinemeta option combinations, and Retry-After parsing.
- `postgres-integration.test.mjs`: real PostgreSQL rollback/concurrency and the same managed storage/job/membership/group/publication contract suites, enabled only by `AIO_TEST_POSTGRES_URL` pointing at a loopback database named `aiomanager_test`. These tests are skipped locally when no test service exists and run in a dedicated CI service.
- `scripts/container-smoke.mjs`: CI-only container checks, no egress or host data mounts; non-root operation, native SQLite, encrypted sync, and restart recovery on AMD64/ARM64.

Successful import results contain plaintext passwords transiently. Never log them or use production exports as fixtures. Durable staging must encrypt credentials before persistence.

`applyAddonSuspension` is a projection over retained configuration. Never save the projection over configured enabled preferences. The worker must persist configuration and suspension state separately and use the projection for display/sync; otherwise renewal could not distinguish a manual disable from expiry.

The passive import UI and dated/lifetime editor have isolated synthetic browser
rehearsals; see [membership evidence](../docs/planning/MEMBERSHIPS.md). Repeat with
`node scripts/ui-rehearsal.mjs --seed-membership`, then `stop` to remove only its
temporary test data. Native OS picker interaction still needs hands-on checking.

Native provider integration, legacy-writer gates, deployment-wide ownership,
scheduled expiry polling/rechecks, activation, offboarding and daily backups are
implemented and covered by later tests in this document. Android TV/provider
acceptance remains a live-environment check. The targeted
`better-sqlite3` rebuild is required for native tests; a scripts-disabled install
alone is insufficient. See [release gates](../docs/planning/VERIFICATION.md).

Group/personal authoring has a separate safe rehearsal:
`node scripts/ui-rehearsal.mjs --seed-groups`. Only the two synthetic `.invalid`
manifest hosts in that helper resolve, using fake in-process transports; all
provider requests remain disabled. Use an interactive terminal and enter `stop`
to remove its temporary database (it also cleans up after 15 minutes). See
[editor evidence](../docs/planning/GROUP-EDITOR.md). Group rollout discovery is
covered on both engines and by authenticated HTTP/client/restart cases.
