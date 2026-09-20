# Managed runtime integration

The 2026-09-20 testing increment connects the existing durable engine to a native
Stremio transport and owner-authenticated activation/control routes. Imports remain
passive. The deployment must enable managed writes; each new manager starts paused.

First-sync receipts bind the saved account version, provider identity/session,
published group and personal setup, protection policy, entitlement and fresh remote
collection. Activation rechecks the receipt and remote collection, then commits
enrollment and a durable job together. Replays perform no further provider work.
The worker snapshots before a change and requires an exact ordered readback.

The native transport uses fixed HTTPS endpoints, bounded response bodies, a shared
single-request budget, 500 ms request spacing, body-inclusive deadlines,
Retry-After, and no blind transport retries. Abort does not free the slot before
the request settles. Manager-only metadata is retained in encrypted saved setup;
the outgoing descriptor contains the manifest, URL, and official/protected flags.
The wire contract follows Stremio's primary
[request types](https://github.com/Stremio/stremio-core/blob/master/src/types/api/request.rs),
[response types](https://github.com/Stremio/stremio-core/blob/master/src/types/api/response.rs),
and [addon descriptor](https://github.com/Stremio/stremio-core/blob/master/src/types/addon/descriptor.rs).
Real-provider/device confirmation is still required.

One deployment owner and a serialized operation queue cover activation, managed
execution and legacy collection writes. Both `/api/stremio-proxy` and backend
Autopilot collection sets resolve the actual Stremio identity and reject enrolled
or removed identities. Headers that label an account do not authorize a write.
The database transaction never contains a provider/manifest network call. Provider
dispatch rechecks the lease, pause, current policy and deployment ownership after
transport queue waiting.

SQLite ownership holds an exclusive transaction on a dedicated OS-locked sidecar.
PostgreSQL ownership uses a dedicated connection and session advisory lock, which
is verified before dispatch; connection loss aborts requests. A persisted dirty
marker imposes a 30-second quarantine after an unclean exit. Requests from another
software installation or Stremio itself cannot be fenced by this API.

Migration 4 adds the authoritative selectable IANA zone and second-precision UTC
offset without rebuilding the released, foreign-key-referenced account table.
The legacy New York column remains for compatibility with migration 1's check;
public APIs and scheduling use the new fields and exact UTC cutoff. Defaults and
legacy records remain New York. Gaps, folds, 30-minute transitions and skipped
calendar dates are tested against ICU timezone rules.

Migration 5 adds runtime/backup bookkeeping, recurring suspension checks and
non-secret offboarding/job tombstones. Expired checks recur roughly every five
minutes, with fresh expiries prioritized over rechecks. Transient outages get
finite retry cycles; credential/data failures require operator repair. Ordinary
active drift receives no recurring rewrite. Verified offboarding removes the
account, provider session, saved addon data, personal-response copies, jobs and
snapshots; job outcomes and provider identity reservations remain to block stale
writers and keep publication history readable. Database archives retain historical
data for the documented retention window.

Daily database archives use streaming gzip plus authenticated AES-256-GCM, atomic
publication and a 14-archive retention limit. Restore authenticates the complete
archive within the import transaction, requires an empty target and matching
schema, restores the keyring, and pauses managed writes and legacy Autopilot.
UI status exposes last scan and backup timestamps. The separate local and Docker
test entry points and owner walkthrough are in [TESTING-MANAGED.md](../TESTING-MANAGED.md).
