# AIOManager API v1

Implemented by this fork. Base URL: `https://YOUR-MANAGER-HOST/api/v1`.
The app manages Stremio account configurations and membership access. It does not
purchase IPTV lines, debrid subscriptions, or TiviMate licenses and has no credit
balance or charges. TV Box Manager should keep those providers as separate adapters.

## Connect

In **Settings → API integrations**, create a named key with an expiry and the
permissions needed by the client. Copy the key once into protected credential
storage; do not store it in TV Box Manager's plain JSON configuration. Keys expire
after 1–365 days. Up to 20 can be active. Revocation prevents new requests; work
already accepted into the durable queue continues. Pause managed sync to stop new
provider writes. Rotate by creating a replacement, testing it, then revoking the old key.

Send `Authorization: Bearer <key>` on every request, with JSON bodies for POSTs.
Use HTTPS and validate certificates. Loopback HTTP is for local development only.
Do not send keys in a URL. `GET /me` is a connection test and returns stable owner
and installation IDs, API/application versions, key permissions and capabilities.
`GET /openapi.json` returns the versioned OpenAPI 3.1.1 contract. A static copy is
in [api/openapi.json](api/openapi.json). Health is available at `/api/health`.

| Permission | Allows |
| --- | --- |
| `read` | Account/group summaries, sync status, operations and connection checks |
| `accounts:write` | Stage/link accounts, rename, membership, group assignment |
| `groups:write` | Create and publish groups; also requires `configuration:read` |
| `sync:write` | Preview/start first sync and request sync |
| `configuration:read` | Complete addon configuration, including private URLs |
| `credentials:read` | Dedicated saved-login endpoint for device setup |
| `accounts:remove` | Verified remote cleanup followed by local removal |

All endpoints require `read` plus their additional permissions. Editing an
account's addon configuration also requires `accounts:write` and
`configuration:read`. Repairing a saved password requires `accounts:write` and
`sync:write`. Keys cannot create/revoke other keys or resume globally paused sync.

## Account workflow

1. `GET /accounts?limit=100` lists accounts. Follow `nextCursor` as `after` until
   null. Maximum page size is 200. Lists exclude passwords and private addon URLs.
2. `POST /accounts` stages an **existing Stremio login**, with `externalRef`,
   `email`, exact `password`, and optional `name`. It does not register a new
   Stremio identity or call Stremio. A new managed record starts inactive.
3. To link an existing manager record, use `POST /account-references` with
   `externalRef` and `accountId`. Creation never silently merges a duplicate email.
   `GET /account-references/{ref}` recovers the association. References are opaque,
   owner-unique strings, 1–128 characters from `A–Z a–z 0–9 _ . : -`. Removed
   records retain reservations so a retry cannot resurrect the account.
4. Set membership with `POST /accounts/{id}/membership`. Use `expectedVersion`
   from the latest account and either `mode: "lifetime"` or `mode: "term"`,
   `local`, `timezone`, and optional `offset` (UTC minutes). A future date renews;
   a past date expires. Nonexistent wall times are rejected; repeated wall times
   need their explicit offset. Default timezone is America/New_York.
5. Assign a published group through `POST /accounts/assign-group`, or save an
   individual setup through `POST /accounts/{id}/addons`. Group operations keep
   staging passive. Addon changes preserve the same protection and expiry rules
   as the UI. Reading an uninitialized individual setup can make a bounded
   read-only Stremio request; ordinary saved reads do not need a provider call.
6. `POST /accounts/{id}/activation-preview` with `expectedVersion` and
   `safeMode: null` returns the reviewed changes and a short-lived receipt.
   Explicitly accept with `POST /accounts/{id}/activate`, including that receipt
   and version. Managed sync must be enabled and resumed from the app.
7. Poll `GET /operations/{jobId}` or `GET /accounts/{id}/execution`. Keep the
   operation ID in the desktop journal. `GET /accounts/{id}/credentials` needs
   the separate permission and returns only the saved email/password; reading
   never rotates either. Credential retrieval should happen only for selected-device setup.

Example membership body:

```json
{"expectedVersion": 3, "mode": "term", "local": "2027-01-15T18:00", "timezone": "America/New_York"}
```

Group create/publish, bulk membership/sync, account renaming, password repair,
and verified offboarding are included in the OpenAPI document. `groupId: null`
detaches accounts while retaining their complete setups. Bulk selections include
each account's ID and expected version and are limited to 200.

## Retries, operations and errors

Every state-changing POST needs an `Idempotency-Key` (16–128 ASCII letters,
numbers, `_` or `-`; UUIDs work). Persist the exact request and key before sending.
The read-only activation preview is the exception. Never generate a new key to
retry an uncertain mutation. Same action/key/intent returns its stored response;
changed intent returns `409 IDEMPOTENCY_CONFLICT`. Keys are scoped to owner and
action, and survive token rotation and server restart. Version conflicts reject
fresh stale edits; a previously committed retry still returns its original receipt.

Recover responses with `GET /receipts/{action}/{key}`. Actions: `create`, `link`,
`name`, `membership`, `bulk-membership`, `assign-group`, `addons`, `sync`,
`bulk-sync`, `activate`, `reconnect`, `offboard`, `create-group`, `publish-group`.
Receipt reads require the original action's permissions. A missing receipt can
mean a request is still in progress; it is not proof of no external effect.

Receipts have no automatic time expiry. Offboarding deliberately purges some
configuration-bearing receipts; use the account's execution tombstone, external
reference and operation history after removal. Application backups preserve
records as of the backup time. Restoring an older backup cannot reconstruct
later requests: reconcile them before resuming writes or retrying missing keys.

HTTP 200 means the request was read or durably accepted, **not** that provider sync
has finished. `jobId: null` means this edit scheduled no provider job. Job states:

| State | Meaning |
| --- | --- |
| `pending` / `running` | Accepted; provider effect is not yet verified |
| `retrying` | Recoverable attempt failed; automatic recovery remains scheduled |
| `verified` | Expected collection was read back from Stremio |
| `failed` | Operator action is needed; never assume there was no remote effect |
| `superseded` | A newer policy replaced this work; inspect current account execution |

Group publication returns rollout information; poll `/groups/{id}/deployment`.
There is no claim of Android device refresh or playback termination in API success.
Errors contain stable `error.code`, sanitized `message`, and `requestId`.
401 means invalid/revoked/expired key, 403 missing permission, 404 unavailable record,
409 conflict, 413 oversized body, and 429 rate limit. A timeout or 5xx has an
uncertain outcome; recover the receipt or repeat the original request.

Limits per server process: 120 requests/minute per key, including at most 30 POSTs,
and 600 requests/minute per directly connected address. Behind a reverse proxy
the address limit is shared unless the deployment intentionally configures trusted
proxy handling. Respect `Retry-After`. Poll one outstanding job every 3–5 seconds.
Most POST bodies are limited to 64 KiB; activation preview is 4 KiB, group drafts
are 2 MiB + 4 KiB, account addon edits are 3 MiB. Rate counters reset on restart;
mutation deduplication does not. Provider requests have separate shared budgets.

## Compatibility and desktop handoff

Additive response fields may appear within v1; clients should ignore unknown fields.
Breaking contracts require a new API major version. This first API has no webhooks
or billed provisioning. The existing TV Box Manager plan remains a proposal for
its desktop integration; this release implements the AIOManager side only.
Use the synthetic HTTP tests and `npm run managed:demo` to develop without real
accounts. No provider purchase should be inferred from AIOManager membership dates.
