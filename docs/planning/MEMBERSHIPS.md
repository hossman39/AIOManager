# Dated and lifetime membership checkpoint

This increment adds per-user membership editing to the passive managed inventory.
It does not enable provider writes, account activation, or an expiry scheduler.

## Contract and persistence

- Imported memberships are **unset**, not lifetime. The editor requires an
  explicit choice of Lifetime or Dated; migration still imports credentials only.
- Lifetime has no automatic cutoff and remains eligible for normal group/personal
  updates. It is not represented by a far-future date.
- Dated membership stores the exact New York wall time, selected UTC offset,
  `America/New_York`, and resolved UTC timestamp. Precision is one minute; no
  inferred end-of-day, annual anniversary, or grace period is added.
- One shared browser/server resolver validates against timezone rules. Invalid
  dates and spring-forward gaps are rejected. Repeated fall-back times require
  an explicit daylight/standard-time occurrence.
- Append-only schema migration 2 adds `lifetime`, defaulting existing records to
  false without changing saved dates or encrypted fields. A database constraint
  prohibits lifetime with a retained cutoff. Migration 1 is unchanged. Older code
  refuses to start against a newer managed schema; downgrade is a tested backup
  restoration workflow, not an automatic column deletion.
- A versioned, authenticated, idempotent save changes the membership, advances
  record/policy versions, writes an encrypted audit event, and (only for an already
  active record) queues its current target in one transaction. A late failure rolls
  all of these back. Staged edits create no jobs and perform no provider requests.
- Expired-to-lifetime is renewal. Lifetime-to-dated uses the selected cutoff,
  including a past cutoff. Offboarding cannot be cancelled by either transition.
  Saved group, credentials, addons, customization, and enabled preferences survive.

## Browser behavior

The inline editor is keyed to a record version, moves focus to its heading, and
returns focus on close/save. Inventory responses cannot overwrite a newer version
already acknowledged in the same tab. Conflicting edits require explicit reload;
the application does not silently overwrite them.

An ambiguous save retains the exact request payload and idempotency key and locks
its inputs until retry/reload. Retry confirms the same operation. A replay fetches
the current record instead of assuming the original response is still current.
Leaving the editor does not cancel a committed request. A save acknowledgement is
not a claim that Stremio has synchronized.

## Evidence and remaining gates

- Local Windows / Node 24.14.0: 139 tests passed, 37 PostgreSQL cases skipped for
  hosted execution, zero failures. Typecheck, lint, and production build passed.
  Existing bundle-size/dynamic-import/Browserslist warnings remain.
- The shared membership contract has ten cases on each database engine, covering
  additive upgrade preservation, unset/lifetime distinction, DST, database
  constraints, concurrent edits, idempotency, renewal races, continued lifetime
  eligibility, offboarding, and atomic rollback after a late failure.
- Five timezone tests also exercise leap/invalid dates and differing host zones.
  HTTP/client tests cover authentication, cross-owner denial, input/body limits,
  contradictory responses, retry keys, and file-backed restart.
- Isolated browser rehearsals used temporary synthetic databases and rejecting
  provider transports. A deliberately lost acknowledgement after server commit
  retained the same payload/key; retry confirmed lifetime without a second edit.
  Spring gaps and unresolved repeated times blocked saving. The selected standard
  occurrence saved/reloaded as `11/1/2026, 1:30 AM EST`; changing it to lifetime
  removed the cutoff and remained staged after reload.
- A 390x844 mobile viewport had no document-level horizontal overflow. The browser
  tool did not reliably dispatch native datetime/select input; those steps used
  DOM input/change events. Actual OS picker interaction remains a release check.
- `node scripts/ui-rehearsal.mjs --seed-membership` creates a fresh synthetic
  manager and inactive user for repeating this workflow. The printed password is
  test-only. The fixture includes the legacy client-encryption salt; no existing
  database is opened. `stop` or the 15-minute timeout removes only its own validated
  temporary directory.

Hosted database/container results must be recorded separately. Real provider
enforcement, Android behavior, group publication, every legacy-writer gate, backup
restoration, and a staged rollout remain required before production use.
