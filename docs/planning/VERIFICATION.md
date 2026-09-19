# Verification and release gates

Status: planned checks, not a passing test report. Current baseline results are in [BASELINE.md](BASELINE.md). The purpose is to detect client-impacting failures before release and bound their effects if one escapes testing.

## 1. Test boundaries

Use unit tests for deterministic policy/comparison logic; database integration tests for transactions, jobs, and migrations; API tests with an injected fake provider; UI tests for the complete workflows; and deliberate failure/load tests for worker behavior. Suitable tools include Node's test runner for the existing JavaScript server, a TypeScript-capable runner for shared domain logic, Fastify injection, and Playwright for the UI. Choose the smallest maintained toolset when M1 is implemented.

Inject the clock, provider client, scheduler, and credential access. Fake-provider tests must capture every attempted remote write, not just final mock state. Test actual JSON contracts and database constraints. Do not depend exclusively on mocks for provider behavior: capture sanitized fixtures and verify a bounded set of contracts with disposable Stremio accounts.

Build a server factory that can initialize routes without automatically starting timers, touching production data, or opening a listener. Synthetic fixtures must not contain live tokens, real client identities, or callable real-provider URLs.

## 2. Required scenario matrix

| Area | Scenarios | Required outcome |
| --- | --- | --- |
| Groups | Add/remove/configure/reorder/disable; individual addons; same manifest ID with different URLs | Exact configuration/order verified; personal extras and disabled preferences preserved |
| Initial setup | New valid identity; duplicate identity; missing key/binding; invalid group | Automatic valid provisioning; invalid cases produce zero writes |
| Policy changes | Rapid publications; reassignment during rollout; member joins during publication | Latest policy wins; no false completion for superseded work |
| Ownership | Staged account; unassigned account; nonempty group deletion; explicit empty publication | No implicit collection clear; destructive actions scoped to reviewed targets |
| Safe mode | Default enabled; configured protected entries; changed protection settings; automatic sync; expiry interaction | Effective collection matches the explicit policy; no false full-replacement/removal claim |
| Legacy writers | Bulk actions, saved-addon propagation, Autopilot, restoration, old browser/cloud state, generic proxy | Managed policy/expiry cannot be bypassed within this server |
| Secrets | Per-user keys, base64/case-sensitive URL segments, credential rotation, cross-owner IDs | No cross-client credentials or secret logs; correct account-specific URLs |
| Expiry dates | Before/at/after exact New York cutoff; nonexistent/repeated DST wall times; leap day; no date | Deterministic entitlement; no day rounding, inferred grace, or early expiry |
| Expiry retention | Protected/default/personal addons; manually disabled entries; remote refresh; restart; repeated suspension | All addons effectively disabled; saved URLs, configuration, order, and manual preferences retained; no addon deletion |
| Expiry races | Expiry versus group publish, renewal, assignment, retries, in-flight requests, server downtime | Final state converges to current policy; pending/error status remains truthful |
| Renewal | Before cutoff; after suspension; while disabling is queued; missing/changed group; edits while expired | Current group/personal setup applied; intentionally disabled entries stay disabled; no empty fallback |
| Offboarding | Cleanup rejected, timeout, stale queued work, verified empty remote collection | Keep account/credentials pending until cleanup verified; only then delete; never revive deleted account |
| Read failures | 401/403, malformed JSON, missing result/addons, 429, 5xx, DNS/network timeout | Errors stay distinct from a valid empty collection; no destructive fallback |
| Write failures | Rejection; accepted write then timeout; successful response with stale readback | Ambiguous outcomes verified before retry; no false success |
| Verification | Same length/different URL; correct URLs/wrong order; custom catalog mismatch; provider normalization | Only the documented expected state counts as verified |
| Durable work | Restart before write, after write intent, after remote acceptance, before local completion | Safe recovery without lost work or duplicate enrollment |
| Concurrency | Duplicate request/job delivery; expired lease; second writer attempt; slow request beyond lease | One supported active writer; local ownership enforced; ambiguous external calls reconciled |
| Backpressure | Many groups, queued expiry, repeated 429s, provider outage | Bounded concurrency/memory; priority without starvation; no retry storm |
| Storage | DB unavailable/full; failed snapshot commit; lock contention; bad migration; missing encryption key | No unsafe remote write after failed preconditions; clear operator error |
| Import | Current/legacy envelopes; missing passwords; duplicate emails/conflicting passwords; irrelevant addon data; oversize input | Exact credential handling, redacted issues, repeatable mapping; no manifest dependency or automatic registration |
| Import side effects | Past expiry; ignored source Autopilot/library payloads; reconnect/reload during staging | Zero provider writes; addon/rule payloads never activate or populate groups |
| User-data preservation | Email/password only, email as name; all other source fields ignored | Exact passwords retained encrypted; no source tokens/history/automation imported |
| Authorization | Anonymous mutation; different owner's ID/key; stale session; forged context header | Rejection with no side effects; no credential disclosure |
| Recovery | Individual snapshot; previous group; database restore; old image; return to original manager | Restore preview and fresh verification; no unintended entitlement bypass |

Property-based or generated cases are valuable for URL identities, ordered collection comparisons, dates, and repeated state transitions. Prioritize invariants over code-coverage percentages. Every discovered defect gets a behavioral regression test.

## 3. Performance targets and methodology

Targets below are provisional budgets, not measured results or provider promises. Test at 40 and 100 clients, plus a simulated 1,000-account stress cohort on the target VPS/runtime. Never run synthetic load against Stremio or paying clients.

| Measurement | Initial target / measurement condition |
| --- | --- |
| Group publish request | Persist/acknowledge within 500 ms p95 for a 40-member group on the agreed host; provider work occurs asynchronously |
| 40-account changed rollout | Within 120 seconds under a healthy fake provider with bounded latency, no throttling, warm manifests, and no competing backlog |
| No-op reconciliation | Zero collection-set requests; at most necessary reads and no redundant per-member shared manifest fetches |
| Request pressure | Configured concurrency and request-start budgets respected under all retries and simultaneous workflows |
| Expiry scheduling | Queued within 60 seconds of cutoff/startup catch-up under healthy database conditions |
| Expiry completion | Measure separately from scheduling; target within two minutes for an ordinary small due cohort with healthy provider/no backlog |
| Progress UI | Responsive while 40/400-account jobs run; ordinary admin API p95 below 500 ms under agreed load |
| Restart recovery | Due work discovered within 60 seconds of readiness; uncertain writes reconciled before replay |
| Resource behavior | No monotonically growing queue/cache/heap across repeated complete workloads; establish and record host-specific RSS/CPU budgets |

At two requests per second, a changed 40-account rollout needing read + write + verify has a rate-budget lower bound of roughly 60 seconds before extra reads, retries, latency, and other work. A single publish triggers everyone, but external writes are not simultaneous or atomic. Expiry bursts and slow provider responses may exceed target completion times and must show overdue status rather than a misleading success.

Run an extended soak (initial minimum: 24 hours) with repeated publications, no-op scans, expiry/renewal transitions, synthetic failures, and at least one restart. Record latency distributions, completed/failed counts, provider call counts, oldest pending age, CPU, memory, and DB growth. Extend the soak when instability or target deployment differences justify it.

## 4. Provider/device capability gate

Using disposable accounts only, verify and record:

1. Disable every addon, including official/Cinemeta, while retaining all saved descriptors in the manager. Confirm an empty active Stremio collection, successful re-enable, and preservation through remote refresh/restart. Identify platform-enforced entries that could prevent disabling all addons.
2. Full replacement without sequential uninstall windows; two configured instances of the same addon remain distinct.
3. Custom manifest/catalog behavior, addon order, and accepted payload/response normalization.
4. Expected error shapes, token invalidation behavior, and slow/ambiguous responses.
5. Refresh on the owner's actual device families with the app open, backgrounded, restarted, and temporarily offline.
6. Renewal restores the desired group/personal setup while leaving intentionally disabled entries off and without touching provider library/history.

If an official addon cannot be disabled on the target device, report the constraint before advertising disable-all. An empty sent array is insufficient: verify remote active state and saved configuration retention. The repository review and pure tests alone do not establish device behavior.

## 5. CI and release pipeline

For each implementation change: lockfile install, typecheck/build, lint, relevant unit/integration tests, and secret/dependency review. New managed writes require fault and ownership tests. Browser workflow tests cover migration staging, publish progress, expiry, and renewal. Exercise supported database engines in isolated CI services; if only one engine is supported for the first release, declare it explicitly instead of implying parity.

Validate the built container on the target runtime/architecture, including native SQLite dependencies when used. Replace the upstream publication destination before enabling fork publishing. Produce immutable image tags/digests and identify the commit/schema version in the app. Staging and production use separate DBs, keys, and provider identities. CI never receives paying-client credentials.

Resolve baseline lint failures. Triage dependency findings for actual runtime reachability and test upgrades; do not run an unreviewed bulk force-fix. No unresolved exploitable high/critical runtime issue may pass release. Document why build-only findings are or are not relevant.

## 6. Release evidence checklist

- [ ] Critical product questions have answers recorded in the V1 specification.
- [ ] Disposable provider/device capability checks support the advertised behavior.
- [ ] Build/lint and relevant automated suites pass on the pinned release.
- [ ] Migration fixtures match the installed source version; staging produces zero remote writes.
- [ ] Email/password inventory reconciles; email defaults as name; other source fields ignored; missing/conflicting passwords actionable.
- [ ] Safe-mode defaults, exceptions, scope, and expiry precedence have explicit acceptance tests.
- [ ] Every existing writer is integrated or explicitly disabled for activated clients.
- [ ] Policy/expiry races, timeout-after-acceptance, and restart recovery pass fault tests.
- [ ] No account/addon/history deletion is part of expiry; disabled records survive sync/restart and manual disable preferences survive renewal.
- [ ] Performance and soak evidence meet agreed budgets or documented revised targets.
- [ ] DB and encryption-key restore has succeeded in an isolated instance with writes off.
- [ ] Individual/group recovery and application/schema rollback have been rehearsed.
- [ ] In-app progress, pause, overdue detection, and actionable error reporting work.
- [ ] Pilot cohort, exact diffs, account ownership transfer, and rollback trigger are recorded.
- [ ] Production runs an immutable release; no unattended upgrade from `latest`.

Stop widening the rollout on any unexpected account modification, wrong credential, premature expiry, unexplained config drift, lost record, secret leak, or unreconciled write outcome. Pause affected work, preserve evidence, recover with verified snapshots, and add a regression test before resuming.

## 7. Reporting standard

Report what changed, what was tested, observed counts/timings, and what remains unverified. A green build is not a migration test, and sending a successful API request is not proof of device behavior. Record failure and partial success explicitly. Do not describe the release as bug-free; describe the tested guarantees and remaining external constraints.
