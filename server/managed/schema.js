import { createHash } from 'node:crypto'

// Released migrations are append-only. A checksum change stops startup rather
// than silently treating an edited migration as already applied.
export const managedMigrations = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'managed-records-and-durable-work',
    sql: `
CREATE TABLE managed_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret_blob TEXT NOT NULL,
  write_paused INTEGER NOT NULL DEFAULT 1 CHECK (write_paused IN (0, 1)),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE managed_owners (
  owner_id TEXT PRIMARY KEY REFERENCES kv_store(key) ON DELETE RESTRICT,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  write_paused INTEGER NOT NULL DEFAULT 1 CHECK (write_paused IN (0, 1)),
  safe_mode INTEGER NOT NULL DEFAULT 1 CHECK (safe_mode IN (0, 1)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE managed_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES managed_owners(owner_id) ON DELETE RESTRICT,
  name_enc TEXT NOT NULL,
  draft_enc TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  published_revision BIGINT,
  safe_mode INTEGER CHECK (safe_mode IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (owner_id, id)
);
CREATE TABLE managed_group_revisions (
  owner_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  config_enc TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  explicit_empty INTEGER NOT NULL CHECK (explicit_empty IN (0, 1)),
  published_at BIGINT NOT NULL,
  PRIMARY KEY (owner_id, group_id, revision),
  FOREIGN KEY (owner_id, group_id) REFERENCES managed_groups(owner_id, id) ON DELETE RESTRICT
);
CREATE TABLE managed_accounts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES managed_owners(owner_id) ON DELETE RESTRICT,
  email_key TEXT NOT NULL,
  credentials_enc TEXT NOT NULL,
  provider_key TEXT UNIQUE,
  provider_enc TEXT,
  state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'active', 'offboarding')),
  group_id TEXT,
  record_version BIGINT NOT NULL DEFAULT 1 CHECK (record_version > 0),
  policy_version BIGINT NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  personal_enc TEXT NOT NULL,
  configuration_enc TEXT NOT NULL,
  expiry_at BIGINT,
  expiry_local TEXT,
  expiry_offset INTEGER,
  expiry_timezone TEXT CHECK (expiry_timezone = 'America/New_York'),
  safe_mode INTEGER CHECK (safe_mode IN (0, 1)),
  applied_version BIGINT,
  applied_target TEXT CHECK (applied_target IN ('active', 'suspended', 'offboard')),
  verified_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, email_key),
  CHECK (state = 'staged' OR (provider_key IS NOT NULL AND provider_enc IS NOT NULL)),
  CHECK (applied_version IS NULL OR (applied_version > 0 AND applied_version <= policy_version)),
  CHECK ((expiry_at IS NULL AND expiry_local IS NULL AND expiry_offset IS NULL AND expiry_timezone IS NULL)
    OR (expiry_at IS NOT NULL AND expiry_local IS NOT NULL AND expiry_offset IS NOT NULL AND expiry_timezone IS NOT NULL)),
  FOREIGN KEY (owner_id, group_id) REFERENCES managed_groups(owner_id, id) ON DELETE RESTRICT
);
CREATE INDEX managed_accounts_group ON managed_accounts (owner_id, group_id, state);
CREATE INDEX managed_accounts_expiry ON managed_accounts (expiry_at, id) WHERE state = 'active' AND expiry_at IS NOT NULL;
CREATE TABLE managed_batches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES managed_owners(owner_id) ON DELETE RESTRICT,
  source_digest TEXT NOT NULL,
  report_enc TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (owner_id, source_digest)
);
CREATE TABLE managed_idempotency (
  owner_id TEXT NOT NULL REFERENCES managed_owners(owner_id) ON DELETE RESTRICT,
  scope TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_enc TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (owner_id, scope, request_key)
);
CREATE TABLE managed_deployments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  cohort_enc TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (owner_id, group_id, revision),
  FOREIGN KEY (owner_id, group_id, revision) REFERENCES managed_group_revisions(owner_id, group_id, revision) ON DELETE RESTRICT
);
CREATE TABLE managed_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  policy_version BIGINT NOT NULL CHECK (policy_version > 0),
  target TEXT NOT NULL CHECK (target IN ('active', 'suspended', 'offboard')),
  cause TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'retrying', 'verified', 'failed', 'superseded')),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  due_at BIGINT NOT NULL,
  lease_token TEXT,
  lease_until BIGINT,
  write_intent INTEGER NOT NULL DEFAULT 0 CHECK (write_intent IN (0, 1)),
  error_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (owner_id, account_id, policy_version, target),
  UNIQUE (owner_id, account_id, id),
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'running' AND lease_token IS NULL AND lease_until IS NULL)),
  FOREIGN KEY (owner_id, account_id) REFERENCES managed_accounts(owner_id, id) ON DELETE RESTRICT
);
CREATE INDEX managed_jobs_due ON managed_jobs (state, due_at, priority DESC, created_at);
CREATE UNIQUE INDEX managed_jobs_one_running ON managed_jobs (account_id) WHERE state = 'running';
CREATE INDEX managed_jobs_lease ON managed_jobs (lease_until) WHERE state = 'running';
CREATE TABLE managed_snapshots (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  job_id TEXT,
  attempt INTEGER,
  collection_enc TEXT NOT NULL,
  collection_digest TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('before-write', 'daily')),
  created_at BIGINT NOT NULL,
  UNIQUE (job_id, attempt),
  CHECK ((source = 'before-write' AND job_id IS NOT NULL AND attempt IS NOT NULL AND attempt > 0)
    OR (source = 'daily' AND job_id IS NULL AND attempt IS NULL)),
  FOREIGN KEY (owner_id, account_id) REFERENCES managed_accounts(owner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, account_id, job_id) REFERENCES managed_jobs(owner_id, account_id, id) ON DELETE RESTRICT
);
CREATE INDEX managed_snapshots_account ON managed_snapshots (owner_id, account_id, created_at DESC);
CREATE TABLE managed_audit (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES managed_owners(owner_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  detail_enc TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX managed_audit_owner ON managed_audit (owner_id, created_at DESC);
`,
  }),
  Object.freeze({
    version: 2,
    name: 'explicit-lifetime-membership',
    sql: `ALTER TABLE managed_accounts ADD COLUMN lifetime INTEGER NOT NULL DEFAULT 0
      CHECK (lifetime IN (0, 1) AND (lifetime = 0 OR expiry_at IS NULL));`,
  }),
  Object.freeze({
    version: 3,
    name: 'durable-suspension-and-execution-plans',
    sql: `ALTER TABLE managed_accounts ADD COLUMN suspended_at BIGINT;
ALTER TABLE managed_jobs ADD COLUMN execution_enc TEXT;
CREATE INDEX managed_accounts_unobserved_expiry ON managed_accounts (expiry_at, id)
  WHERE state = 'active' AND lifetime = 0 AND expiry_at IS NOT NULL AND suspended_at IS NULL;
UPDATE managed_accounts SET suspended_at = COALESCE(verified_at, updated_at)
  WHERE state = 'active' AND lifetime = 0 AND expiry_at IS NOT NULL
  AND ((applied_target = 'suspended' AND applied_version = policy_version)
    OR EXISTS (SELECT 1 FROM managed_jobs j WHERE j.account_id = managed_accounts.id
      AND j.policy_version = managed_accounts.policy_version AND j.target = 'suspended'
      AND j.state <> 'superseded'));`,
  }),
])

export function migrationChecksum(migration) {
  return createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest('hex')
}

export async function migrateManagedSchema(db, migrations = managedMigrations, now = Date.now()) {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1)
      throw new Error('Managed migration versions must be contiguous')
  }
  await db.transaction(async (tx) => {
    if (tx.type === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(804160, 1)')
    await tx.exec(`CREATE TABLE IF NOT EXISTS managed_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL
    )`)
    const applied = await tx.query(
      'SELECT version, name, checksum FROM managed_schema_migrations ORDER BY version'
    )
    for (const [index, row] of applied.entries()) {
      const expected = migrations[index]
      if (!expected || row.version !== expected.version)
        throw new Error('Unsupported managed database schema; use a compatible application version')
      if (row.name !== expected.name || row.checksum !== migrationChecksum(expected))
        throw new Error('Managed migration history mismatch; restore or review before startup')
    }
    for (const migration of migrations.slice(applied.length)) {
      await tx.exec(migration.sql)
      await tx.run(
        'INSERT INTO managed_schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
        [migration.version, migration.name, migrationChecksum(migration), now]
      )
    }
  })
}
