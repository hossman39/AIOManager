# Implementation progress

Updated 2026-09-19. These are foundation increments, not a deployable managed-groups release. No paying accounts, production database, or deployment has been accessed or modified. Backend work and its evidence are recorded in [BACKEND-FOUNDATION.md](BACKEND-FOUNDATION.md) and [MANAGED-STORAGE.md](MANAGED-STORAGE.md). Branch checkpoints/CI do not authorize production rollout.

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

## Current local evidence

113 tests pass; 27 real PostgreSQL cases are skipped locally and are assigned to
the hosted PostgreSQL service. Typecheck, lint, and build pass. Both production
dependency audits report zero known findings. The managed slice's hosted results
are pending its branch checkpoint. Synthetic 100-account staging/inventory and
file-backed account/job/snapshot restart recovery pass; these are not provider
throughput or real-device measurements.

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

## Next engineering work and release blockers

1. Verify the new managed storage/job contracts in hosted PostgreSQL and container CI. Keep publishing manual/fork-owned; no image has been published.
2. Implement single-writer provider execution, bounded requests, retry policy/circuit breaker, and every existing writer's ownership/expiry gate. The tested internal job store is not sufficient by itself to activate clients.
3. Connect encrypted, idempotent staging to a preview/activation UI. Verify the owner's actual export locally; never request client passwords in chat.
4. Implement group draft/publish, first-sync safe mode, individual addons, and visible rollout status, preserving existing customization and new-account creation.
5. Implement exact America/New_York expiry/renewal, persisted suspension, an Expired view, and verified offboarding. No addon deletion is an expiry operation.
6. Prove backup restoration, provider/Android contracts, concurrent changes, restart recovery, and 40/100-account load plus soak behavior before selecting a live pilot.

The [verification plan](VERIFICATION.md) remains the release authority. These unit tests do not establish zero bugs, complete migration, durable expiry, or real-device behavior.
