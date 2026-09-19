# Foundation tests

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
- `managed-jobs.test.mjs` / `managed-job-contract.mjs`: durable claims, pause, lease recovery, per-attempt encrypted snapshots, atomic write intent, stale completion, expiry/renewal races, and file-backed restart. No remote worker is enabled by these tests.
- `postgres-integration.test.mjs`: real PostgreSQL rollback/concurrency and the same managed storage/job contract suites, enabled only by `AIO_TEST_POSTGRES_URL` pointing at a loopback database named `aiomanager_test`. These tests are skipped locally when no test service exists and run in a dedicated CI service.
- `scripts/container-smoke.mjs`: CI-only container checks, no egress or host data mounts; non-root operation, native SQLite, encrypted sync, and restart recovery on AMD64/ARM64.

Successful import results contain plaintext passwords transiently. Never log them or use production exports as fixtures. Durable staging must encrypt credentials before persistence.

`applyAddonSuspension` is a projection over retained configuration. Never save the projection over configured enabled preferences. The worker must persist configuration and suspension state separately and use the projection for display/sync; otherwise renewal could not distinguish a manual disable from expiry.

Provider execution and all legacy-writer gates, persistent expiry scanning, New
York datetime input, import wizard, group/personal UI, offboarding, daily backups,
and Android/provider verification remain implementation work. The targeted
`better-sqlite3` rebuild is required for native tests; a scripts-disabled install
alone is insufficient. See [release gates](../docs/planning/VERIFICATION.md).
