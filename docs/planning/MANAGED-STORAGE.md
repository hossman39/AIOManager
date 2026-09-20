# Managed storage implementation contract

This is the M2/M3 persistence slice, not permission to activate clients. The first
routes support authenticated, passive staging only. They cannot call Stremio,
register an account, fetch a manifest, or start an addon writer.

## Boundaries

- Reuse the administrator's existing sync identity and derived sync token, verified
  on the server. `x-manager-id` identifies that identity; `x-sync-password` proves
  access. Neither a client-account ID nor `x-account-context` grants ownership.
- Every managed query scopes by the authenticated owner. Same-owner foreign keys
  protect memberships, jobs, revisions, and snapshots. Provider identity will have
  a deployment-wide unique keyed fingerprint when enrollment is implemented.
- A managed owner references the original sync identity with delete restricted.
  Legacy sync deletion must report a conflict instead of orphaning managed data or
  making the identity available for another password to claim.
- No cookies are introduced. Managed responses are non-cacheable, error responses
  use fixed messages, and request bodies/tokens are never logged by these routes.
- New records use strict, versioned authenticated encryption bound to record ID,
  owner, and purpose. They never use legacy plaintext decryption fallback. A wrapped
  deployment index key keeps keyed indexes stable across encryption-key changes.
  Startup checks the wrapped key; lost/corrupt data fails closed.

## Schema and concurrency

Numbered additive migrations execute in a single transaction. PostgreSQL takes a
transaction-level advisory migration lock; SQLite uses `BEGIN IMMEDIATE`. Stored
migration checksums detect changed history and newer schemas stop older code.

Owner mutations lock the owner's row within the transaction (SQLite's transaction
already serializes writes). This intentionally trades unnecessary owner-level
parallel writes for predictable behavior at 40–100 accounts. Network calls never
belong inside these transactions. Published revisions are immutable. Versioned
updates use compare-and-swap; stale browser operations return conflict.

Idempotency records and their resulting mutation commit together. The same request
key with different normalized content is a conflict. Independently, an import's
keyed semantic fingerprint deduplicates equivalent batches even with a new request
key. Ignored addon data does not become part of the import contract.

## Staging behavior

The existing pure parser is shared between browser and server. Only valid
email/password candidates are eligible. Row-level issues remain in the batch report.
New records are staged, ungrouped, without expiry, with empty personal/saved addon
layers. Passwords retain every character. The default name is the retained email.

Reimporting an existing normalized email never replaces credentials or changes its
management state. An exact saved password match maps to the existing account;
different passwords produce a row-level conflict requiring deliberate resolution.
One transaction commits all new accounts, the encrypted row mapping/report, and
the idempotency response. A failure rolls back the whole batch. Returned inventories
never contain passwords, auth keys, encrypted envelopes, or keyed fingerprints.

## Durable job boundary

Job identity includes the account, policy version, and target (active, suspended,
or offboard). Duplicate delivery creates no extra job. Claims use leases and random
fencing tokens; completion requires the current token and policy. An expired lease
with write intent remains an unknown outcome that a future worker must read before
writing. A snapshot and write intent commit before any remote dispatch. Snapshots
are encrypted and cannot be moved between owners/accounts without authentication
failure. Staged accounts cannot have runnable jobs.

Lease fencing only protects local state. It cannot revoke a remote request already
accepted by Stremio. The provider phase still requires the specified single writer,
bounded calls, pause/drain controls, identity validation, and read-after-write
verification. These storage APIs are not a complete or enabled provider worker.

## Required evidence

- SQLite and real PostgreSQL: repeat startup, migration rollback/checksum/version
  checks, foreign-key ownership, concurrent staging, idempotency, restart persistence.
- Encryption: tamper/wrong-key/cross-record failures, key-ring reads, stable indexes,
  missing metadata with retained data, no plaintext credentials in database files.
- HTTP: unauthorized/cross-owner requests, malformed/oversized inputs, fixed error
  messages, password-free inventories, import creates no jobs or provider calls.
- Queue: duplicate jobs, one claim per account, stale leases/completion, expiry
  priority, snapshot-before-intent, pause, restart, and policy supersession.

Live activation and UI integration remain separate delivery gates.

## Implementation and first local evidence

Implemented in `server/managed`, with one shared passive parser in `shared`.
The authenticated HTTP surface is limited to status, paginated accounts, import
preview, passive staging, and retained batch reports. Credentials never appear in
these responses. Imports create no addon jobs and provider-write capability reports
false. The internal job API has no HTTP route and no scheduler starts it.

At this checkpoint the local suite passed 113 tests with 27 PostgreSQL cases assigned
to the hosted service. Identical storage/job contracts are registered for both engines.
Native SQLite file close/reopen covers persisted staging, idempotency, job recovery,
and snapshots. Static checks/build and production dependency audits passed. All
Windows/Linux, PostgreSQL, AMD64, and ARM64 jobs passed for `01abed9` in
[run 35473935488](https://github.com/hossman39/AIOManager/actions/runs/35473935488).

Implementation follows PostgreSQL's [locking-clause contract](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
for `FOR UPDATE ... SKIP LOCKED`, and Node's [authenticated-encryption API](https://nodejs.org/api/crypto.html#ciphersetaadbuffer-options)
for record-context binding. Encryption-key rotation is not automated: retained
envelopes still require their matching key-ring entries and backup material.
