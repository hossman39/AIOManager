# Contributing to the managed AIOManager fork

This fork is maintained at [hossman39/AIOManager](https://github.com/hossman39/AIOManager).
Open pull requests against its `main` branch. The upstream authors retain their
credits in the README and license.

## Structure

- `src/`: React, TypeScript and Vite interface.
- `server/`: Fastify service, SQLite/PostgreSQL storage, encrypted records and jobs.
- `server/managed/`: account policies, groups, expiry, provider execution and backups.
- `shared/`: contracts and transformations used by the browser and server.
- `tests/`: synthetic application and database tests.
- `docs/planning/`: decisions and historical checkpoints; start with `PROGRESS.md`
  for current status.

The server is required for managed accounts, sync, expiry and backups. Production
uses one application container serving both the UI and backend. See
[DEPLOY.md](DEPLOY.md); GitHub Pages/static hosting is not the deployment path.

## Local development

Use Node 24 and the committed lockfile:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild better-sqlite3 --ignore-scripts=false
npm run managed:demo
```

The demo uses temporary synthetic accounts and a fake provider. It prints its
local URL and login instructions; enter `stop` to shut it down and clean its own
temporary data. This is the quickest way to review managed screens without using
client accounts.

For frontend development, create a local root `.env` with `PORT=16100`,
`DATA_DIR=./data`, `DB_TYPE=sqlite`, and `MANAGED_WRITES_ENABLED=false`, then run
`npm run dev`. Vite proxies `/api` to port 16100. Use only development credentials;
the plain development server is not the synthetic demo. The Docker environment
example uses port 1610 and `/app/data`, so adjust those values for local use.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

CI runs Windows/Linux checks, PostgreSQL integration contracts, and AMD64/ARM64
container smoke checks. PostgreSQL cases skip locally unless the dedicated test
database is configured. See [tests/README.md](tests/README.md) for the test boundary
and [docs/TESTING-MANAGED.md](docs/TESTING-MANAGED.md) for manual checks.

Describe the problem, resulting behavior and relevant validation in the PR.
Preserve stored configuration, idempotency and encryption boundaries. Keep real
credentials, local databases, application archives and keys out of fixtures and
commits. Update the deployment guide when changing runtime configuration.
