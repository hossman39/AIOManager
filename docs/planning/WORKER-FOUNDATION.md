# Managed execution and durable expiry foundation

Updated 2026-09-20. This increment implements the internal execution engine with
an explicitly injected provider. The application does not construct it, start an
expiry timer, or enable provider writes. There is no activation route. The local
runner guard is not a deployment-wide writer lock. Production integration remains
gated by [VERIFICATION.md](VERIFICATION.md).

## Implemented behavior

- Additive migration 3 stores the first observed suspension and encrypted execution
  plans. Existing, current-policy suspension evidence is retained on upgrade;
  an already-recorded renewal is not undone. Released migrations 1 and 2 are unchanged.
- An indexed scan processes at most 200 due accounts per transaction (100 by
  default), excluding staged, lifetime and future memberships. Recording suspension
  and enqueueing its job commit together, including while writes are paused. Once
  recorded, suspension survives clock rollback, publication, job recovery and restart.
  Only an explicit future-date/lifetime membership edit lifts it. Observation advances
  the account's public record version so old editors cannot overwrite it silently.
- Execution loads encrypted enrollment state, the immutable published revision,
  personal addons, saved configuration and effective safe mode. It validates the
  deployment identity fingerprint and checks the provider's actual identity before
  reading its collection. Invalid/missing/unreadable data never becomes an empty list.
- Projection preserves configured URL case, distinct instances, group/personal
  order, metadata, catalog edits and Cinemeta choices. Safe mode anchors existing
  protected/default entries; manually disabled entries remain saved. Expiry projects
  an empty active collection and retains clean descriptors, including unseen remote
  defaults. It never stores an empty/disabled projection over saved preferences.
- Matching state completes without a write. Otherwise a snapshot, exact execution
  plan, retained configuration and write intent commit atomically before dispatch.
  Lease, policy, pause, identity binding and effective settings are checked again
  after request-budget waits. Readback compares the complete ordered JSON collection;
  no provider normalization has been assumed or silently ignored.
- A lost response or expired lease is reconciled by reading first. Exact acceptance
  completes from the persisted plan without writing again. If state differs, a fresh
  projection also preserves newly protected/default remote entries. Changed policy
  or settings cannot be reported as current; corrective work remains queued.
- One local runner processes one account at a time. Concurrent polls share the
  current execution; duplicate construction with the same database object fails.
  Default request spacing is 500ms, timeout 10 seconds, and verification is limited
  to two readbacks. Aborting a request does not release the slot until that request
  settles. Shutdown aborts and drains the outstanding operation.
  Repeated shutdown calls are idempotent and cannot release a replacement runner's
  ownership guard.
- Retry deadlines, fixed error codes and attempts are durable. Exponential backoff
  has jitter and a five-attempt limit; invalid credentials/identity/data require
  attention. Retry-After supports seconds and HTTP dates. Three transport failures
  open a 30-second local circuit; throttling also holds the local queue. Active
  clients have no periodic drift rewrite.

The cancellation contract follows Node's documented [request abort behavior](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html):
a timeout event alone does not terminate a request. The runner requires a provider
that honors AbortSignal and retains ownership until settlement. Cancellation cannot
undo a remote request already accepted by a provider.

## Verification

Synthetic provider contracts run on native SQLite and the same isolated PostgreSQL
suite in CI. They capture every provider call and check snapshots/configuration
before dispatch. Coverage includes no-op completion, wrong identity, corrupted
revision, malformed reads, wrong-URL/stale readback, snapshot commit failure, pause,
accepted-write/lost-response retry, newly protected entries on retry, expiry/renewal
and safe-mode races, bounded retries/circuit breaking, rollback, upgrade and a
100-account bounded scan/execution cohort. No synthetic account calls a real service.

Separate file-backed SQLite close/reopen testing simulates provider acceptance
before local completion and verifies recovery without another write. A delayed
provider that ignores cancellation until its lease expires cannot free the runner
early or overlap a later execution. Pure projection tests cover clean descriptor
retention and all eight Cinemeta-option combinations.

Local and hosted check results are recorded in [PROGRESS.md](PROGRESS.md).

## Remaining integration and release work

1. Acquire deployment-wide ownership for the single writer service across processes
   and database connections. The WeakSet guard and database job leases cover local
   execution, not remote fencing. The application must not wire this runner to a
   live adapter until ownership and all legacy writer gates are enforced.
2. Implement the bounded native Stremio HTTP adapter, shared request budgets with
   existing reads/writers, session/enrollment validation and generic-proxy ownership
   checks. The injected interface has no network fallback and never registers users.
3. Connect reviewed activation, first-sync choices and operational status. Keep
   the existing deliberate new-account creation workflow separate from migration.
4. Wire startup/30-second expiry scans and recovery polling into lifecycle controls.
   Add rate-limited rechecks of verified/failed expired accounts to enforce expiry
   after later external changes, without resetting retry budgets on every scan.
   Add the Expired view and verified offboarding. Current scan deduplication only
   records a newly observed deadline; it does not claim perpetual enforcement.
5. Verify disposable provider/Android contracts, actual provider-normalized fields,
   backup restoration, cross-process failover, target-host throughput and soak.
   Fake time/request spacing and the 100-account cohort are not VPS or provider
   performance measurements.
