# Implementation progress

Updated 2026-09-19. These are foundation increments, not a deployable managed-groups release. No paying accounts, production database, or deployment has been accessed or modified. Backend work and its evidence are recorded in [BACKEND-FOUNDATION.md](BACKEND-FOUNDATION.md). Branch checkpoints/CI do not authorize production rollout.

## Completed locally

- Reconciled the plan with the owner's decisions, including individual addons, exact New York expiry, credential-only migration, preserving new-account creation, and no blanket active-account drift enforcement.
- Corrected expiry to **disable, not delete**. Retain saved addon descriptors, URLs, customization, order, protection, and manual enabled preferences. Upstream's enabled-only serializer omits disabled addons from Stremio's active collection.
- Added a pure suspension projection and tests for disable-all, renewal, personal/protected addons, remote refresh, repeated transitions, and serialized configuration retention. It is not connected to a timer, database, or UI yet.
- Added a passive email/password parser for current 2.0.0 Settings exports and legacy account arrays/envelopes. No imports of source addons, auth tokens, or history; no registration, login, persistence, or provider write. Missing passwords and conflicts are explicit.
- Added 46 unit/compatibility tests and typechecking of the tests. Existing login/registration, custom metadata/catalogs, protected addons, disabled-state retention, and configured URL identity have initial regression coverage.
- Resolved the upstream baseline's two lint errors and seven warnings through small regex/const/dependency/unused-variable fixes; no lint rules were weakened.
- Added a read-only quality workflow for Windows/Linux using pinned action commits and the verified local Node version. Hosted CI has not run; there is no new deployment step.

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

1. Verify the backend foundation in hosted CI: PostgreSQL and both container architectures. Local native SQLite/server tests and targeted production dependency updates pass; the new publishing workflow is manual/fork-owned and has not published anything.
2. Implement authenticated server-side managed records, transactional jobs, encrypted configuration/snapshots, single-writer execution, verification, retries, and every existing writer's ownership/expiry gate.
3. Connect passive import to encrypted, idempotent staging and a preview/activation UI. Verify the owner's actual export locally; never request client passwords in chat.
4. Implement group draft/publish, first-sync safe mode, individual addons, and visible rollout status, preserving existing customization and new-account creation.
5. Implement exact America/New_York expiry/renewal, persisted suspension, an Expired view, and verified offboarding. No addon deletion is an expiry operation.
6. Prove backup restoration, provider/Android contracts, concurrent changes, restart recovery, and 40/100-account load plus soak behavior before selecting a live pilot.

The [verification plan](VERIFICATION.md) remains the release authority. These unit tests do not establish zero bugs, complete migration, durable expiry, or real-device behavior.
