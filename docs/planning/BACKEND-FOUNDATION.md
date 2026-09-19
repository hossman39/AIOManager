# Backend foundation increment

Work in progress, 2026-09-19. This increment prepares isolated testing and persistence; it does not enable managed groups or expiry against any account.

## Changes and rationale

- `server/app.js` exports a factory with injected database, configuration, provider transport, and logger. Importing it performs no filesystem writes, socket binding, signal registration, or background work. The executable `server/index.js` explicitly starts listening/workers. Shutdown stops scheduling, drains the current worker, checkpoints SQLite, and closes storage.
- The DB adapter now exposes transactions. PostgreSQL uses one checked-out client from BEGIN through COMMIT/ROLLBACK; failed rollback discards that client. SQLite serializes unrelated requests across async transactions. Escaped transaction handles reject late writes. Numbered parameters are bound by name, not regex-rewritten; repeated/out-of-order parameters and SQL literals are covered.
- SQLite uses foreign keys, bounded busy timeout, WAL, and FULL synchronization. Performance still needs measurement on the actual VPS; reliability takes precedence over avoiding a disk flush at this scale.
- Remote PostgreSQL TLS verifies certificates. Internal hosts can explicitly select `DB_SSL_MODE=disable`; URL parameters cannot silently override the TLS policy. An existing deployment using SSL URL parameters must translate them to the explicit setting before cutover.
- Missing/empty persistent encryption keys fail startup when retained data exists. Fresh installations generate a restricted-permission key and flush it before use. This guards against an incorrectly mounted/lost key volume; it is not yet a complete key-rotation or backup feature.

The adapter follows the primary documentation for [PostgreSQL transactions](https://node-postgres.com/features/transactions), [SQLite binding/transactions](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), and [Fastify injection](https://fastify.dev/docs/latest/Guides/Testing/). External provider calls must never occur inside a DB transaction.

## Dependency review

Targeted production updates: `@fastify/static` 10.1.4, Fastify 5.12.5, Axios 1.20.0, fflate 0.8.3, React Router DOM 7.18.4, and UUID 13.0.1. Refreshed affected transitive dependencies within their declared ranges. Moved development-only `concurrently` and the Tailwind animation build plugin out of production dependencies. Fixed the standalone server manifest's missing Axios/pg/pino-pretty declarations.

After changes, `npm audit --omit=dev` reports zero known findings in both root and server lockfiles. This is a registry advisory check, not proof of application security, OS-image security, or zero defects. Full development-dependency audit and existing proxy/Autopilot authorization issues still require separate review.

The static plugin's [compatibility table](https://github.com/fastify/fastify-static#compatibility) supports Fastify 5. Static SPA behavior, encoded/traversal attempts, encrypted sync, and API startup are covered by local tests after the upgrade.

## Container and CI boundary

- Node 24.21.0 is selected from the official [LTS release](https://nodejs.org/en/blog/release/v24.21.0); the Node Bookworm slim image is pinned to the retrieved multi-platform digest. All stages share its runtime/native-module ABI. The runtime is slim/non-root (UID 1000), not the old distroless image. Existing volume permissions must permit this UID before deployment.
- Builds use the lockfile. Only the SQLite native dependency's install scripts are explicitly run; compiler packages stay out of the runtime stage. Docker context excludes keys, databases, and local data volumes.
- CI checks Windows/Linux, a disposable PostgreSQL service, and no-egress AMD64/ARM64 containers. All five jobs passed for `be5d9de` in [run 35472588828](https://github.com/hossman39/AIOManager/actions/runs/35472588828). Docker and PostgreSQL executables are absent locally.
- The inherited upstream Docker Hub destination and automatic push/tag publishing were removed. Publishing is a separate manual workflow on main after checks, defaults to no push, targets only this fork's GHCR namespace, and uses commit-specific tags. No image has been published or deployed.

## Local evidence so far

At this checkpoint, 71 tests passed locally; 2 PostgreSQL tests ran successfully in
hosted CI. Native SQLite, rollback, 100 concurrent transaction updates, file-backed
restart, key loss, server lifecycle, existing sync authentication, and addon/migration
compatibility were exercised. Typecheck/lint/build also passed on Windows/Linux.
Newer managed persistence evidence is tracked in [PROGRESS.md](PROGRESS.md); real
Stremio/Android behavior and production restore remain release gates.
