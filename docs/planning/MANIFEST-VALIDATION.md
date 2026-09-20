# Managed manifest validation

Implement a separate read-only adapter before exposing publication. Do not reuse
legacy proxy fallbacks that synthesize an empty/unknown manifest on failure.

## Contract and limits

- The operator supplies the complete manifest URL. Preserve configured path/query
  bytes, case, and order; translate only the `stremio://` scheme to HTTPS for IO.
  Never append/remove `manifest.json` or guess credentials. GET only, no cookies,
  manager credentials, provider tokens, proxy environment, or response logging.
- Validate bounded plain JSON and the Stremio manifest structure. A configured
  URL must return the saved manifest ID and must not require further configuration.
  Keep curated names/catalogs/metadata unchanged; validation does not replace them.
  Disabled entries require valid saved descriptors but no network read. This lets
  an operator disable an unavailable addon and retain it for later repair.
- Public unicast destinations by default. Validate every IPv4/IPv6 DNS answer and
  pin the actual connection to those answers. No second, unchecked DNS resolution.
  Reject local/link-local/metadata/reserved/transition addresses. TLS certificate
  checks remain enabled. Public HTTP is retained for source compatibility; HTTPS
  should be used for credential-bearing URLs.
- A server-only exact-origin allowlist may permit explicitly named private-network
  services for a Docker stack. It does not permit loopback, metadata, link-local,
  multicast, unspecified, or reserved destinations. No broad disable-safety flag.
- At most two same-origin redirects; resolve and revalidate each hop. No cross-
  origin redirect or HTTPS downgrade. Use the actual final URL for such services.
- Three concurrent reads across all callers, at most twelve waiting reads, eight
  seconds per read including DNS/redirects/body, twenty-five seconds per batch,
  and 2 MiB per response (including decompressed output). No automatic retries or
  cross-user URL cache. A publication validates its shared group once, not once
  per member. These are defensive initial limits, not provider rate promises.
- DNS uses a cancellable resolver for A/AAAA records, not OS hosts-file aliases.
  Aborts stop queued work, DNS, requests, and body consumption. Shutdown aborts
  outstanding managed reads; no background timer/listener starts on import.

## Integration

Authenticated managed routes resolve a manifest, preview/publish a group, and
read recorded deployment progress. All use no-store headers and fixed redacted
errors. Preview validation runs outside transactions; publication still rechecks
its encrypted receipt/cohort. These endpoints do not activate staged users or
perform Stremio collection writes. Existing writer/expiry gates remain mandatory.

`MANAGED_MANIFEST_PRIVATE_ORIGINS` accepts a comma-separated list of exact origins,
for example `http://addon.internal:8080,https://another.internal`. Leave it unset
for public-only resolution. It grants those reads to authenticated managers of
this instance; protect the single-admin deployment accordingly. It never disables
TLS validation. Deployment-specific DNS, private origins and outbound firewall
rules must be reviewed on the actual Docker network before a pilot.

## Required verification

Use injected synthetic DNS/HTTP transports to test exact URL handling, pinned
lookup (both callback shapes), TLS options, no headers/secrets forwarded, IPv4/
IPv6 bypasses, mixed DNS answers, rebinding, redirect hops/loops/cross-origin,
compressed/oversized/partial/malformed JSON, configuration-required responses,
ID mismatch, abort/timeout, global concurrency/queue bounds, no retries, and
disabled descriptor retention. Add a real loopback HTTP transport-contract test
using a test-only injected connection; production policy must still reject that
address. No tests call addon providers or paying accounts.

Record HTTP tenancy/body-limit/replay/restart behavior separately. Green fake-
transport tests do not establish actual provider compatibility, device behavior,
or the deployment network's egress isolation.

## Implemented verification

Twenty-one focused adapter tests pass with synthetic transports and real loopback
HTTP streaming/pinned lookup. Five HTTP scenarios cover resolution bounds,
mixed-entitlement publication and encrypted restart replay, stale/invalid receipts,
explicit empty consent, and cancelling a read by disconnecting a real HTTP client.
Four browser-client cases cover full descriptor fidelity, scoped requests, exact
publication retry, fixed errors, and rejecting inconsistent progress. No external
manifest host or Stremio collection is contacted by these tests.

The final full suite passed 211 local cases, with zero failures and 70 PostgreSQL
cases reserved for hosted CI. Typecheck, lint and build passed;
the typecheck caught an ES2022-only array helper in a new test, replaced with
compatible indexing without changing the application's target. Both production
dependency audits report zero known vulnerabilities. The added explicit ipaddr.js
dependency changes no existing resolved package versions.

## Design references

Connection pinning and redirect checks follow the threats described in the
[OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
Custom lookup must support the all-address callback used by Node's family
selection; see [Node 24 net options](https://nodejs.org/docs/latest-v24.x/api/net.html#socketconnectoptions-connectlistener)
and [HTTP request options](https://nodejs.org/docs/latest-v24.x/api/http.html#httprequesturl-options-callback).
Remote shape checks follow the
[Stremio manifest contract](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md).
The already-resolved `ipaddr.js` 2.3.0 becomes an explicit pinned dependency for
address classification; this is not an unrelated dependency upgrade.
