# Discovery evidence and baseline

Inspected 2026-09-19. Findings describe the pinned source and local checks; they are not results from the owner's production installation.

## Source versions

| Project | Revision | Role |
| --- | --- | --- |
| [AIOManager](https://github.com/Sonicx161/AIOManager/tree/dfbbc3412c1928554670d27457fd4983de59dbe8) | `dfbbc3412c1928554670d27457fd4983de59dbe8`, version 1.8.5 build 2 | Fork baseline |
| [Personal fork](https://github.com/hossman39/AIOManager) | Same default-branch commit at inspection | Existing destination |
| [Slicksync](https://github.com/slicknsliding/slicksync/tree/33023f4cd887c12daa56788da7ad0ef2da83d581) | `33023f4cd887c12daa56788da7ad0ef2da83d581`, package version 1.86.0 | Feature and failure-mode reference |

Preserve the upstream license and attribution. If selected reference code is reused later, record its origin and retain applicable notices. No Slicksync code has been copied.

## AIOManager architecture

The UI is React/TypeScript/Vite, with Zustand stores and browser IndexedDB through localforage. Node/Fastify supplies encrypted state sync, API proxies, and the existing Autopilot worker. The database adapter supports SQLite and PostgreSQL.

| Finding | Source | Consequence for V1 |
| --- | --- | --- |
| Account records and most account operations live in browser state | `src/types/account.ts`, `src/store/accountStore.ts` | Automatic groups/expiry need durable server-owned records |
| Profiles organize saved addons, with no account membership relationship | `src/types/profile.ts`, `src/types/saved-addon.ts` | A new managed group model is needed; do not reinterpret existing profiles silently |
| Bulk account refresh uses `Promise.all` and skips hidden documents | `src/store/accountStore.ts`, `syncAllAccounts` | Browser refresh is unsuitable as a subscription scheduler |
| The server queues proxy requests in memory; Autopilot overlap prevention is process-local | `server/index.js`, `proxyQueue`, `isWorkerRunning` | Restart-safe work and account serialization need persisted state |
| Autopilot evaluates batches of 100 rules, with proxy concurrency defaulting to 50 | `server/index.js` | New work must share a deliberate provider request budget |
| Addon writes replace the remote collection; disabled entries are filtered out | `src/api/addons.ts`, `updateAddons`; `src/api/stremio-client.ts`, `setAddonCollection` | A missing/invalid desired list must never become an accidental clear |
| Write verification is delayed, compares only list length, and logs warnings | `src/api/stremio-client.ts`, `setAddonCollection` | Completion must instead depend on an awaited, order-aware comparison |
| A malformed collection response lacking `result.addons` can be returned as `[]` | `src/api/stremio-client.ts`, `getAddonCollection` | Distinguish successful empty reads from invalid responses before planning writes |
| The existing expiry dashboard concerns provider subscription keys | `src/components/dashboard/ExpiryDashboard.tsx` | Client membership expiry is a separate feature |
| The DB wrapper has query/run helpers but no transaction abstraction | `server/db.js` | Add tested transactions and versioned migrations before durable jobs |
| New server records cannot rely on the UI's unlocked state for authorization | `server/index.js`, sync/proxy/Autopilot routes | Authenticate and scope every affected route; review legacy bypasses |

The Autopilot mutation routes shown in `server/index.js` do not have a shared authorization hook in this source. The general Stremio proxy accepts a caller-supplied auth key. This is a code-review finding, not an exploit test. Before exposing managed-account automation, account ownership and all affected write paths must be enforced on the server.

## Migration findings

Scope update after discovery: the owner requires migration of user data only and expects group provisioning to replace existing addons, with customizable safe mode on by default. The addon-export limitations below remain source observations, but are not migration blockers. Vault/profile/rule migration is out of scope; viewing-history capture depends on the owner's definition of user data.

The Settings export calls `exportAccounts(true)` and downloads JSON. Account auth keys and any stored passwords are decrypted into that file. Addon URLs and webhook URLs may also contain secrets. Export files must stay out of chat, source control, CI artifacts, and ordinary logs.

The standard export uses format `2.0.0`, with a manifest dictionary and account references. It includes accounts, saved addons, profiles, account addon state, failover configuration, and selected UI settings. It is not a complete backup of all stores:

- Vault is included in the encrypted cloud-sync envelope but omitted from the Settings export.
- Activity history, library cache/deletion markers, and other local data need an explicit inventory and separate capture where required.
- Account addon serialization includes flags and metadata but omits the `catalogOverrides` field.
- Manifests are deduplicated using `manifest.id:manifest.version`; different configurations sharing those values can lose distinct manifest data in the export.
- The current import routine mutates multiple stores and launches follow-up account synchronization. It is not a transactional, passive migration preview.
- A matched imported account's auth key is treated as already encrypted based on its length. A migration adapter must identify credential format explicitly rather than reuse that heuristic.

Sources: `src/pages/SettingsPage.tsx` around `handleExport`; `src/store/accountStore.ts` around `exportAccounts`/`importAccounts`; `src/store/syncStore.ts` around cloud state serialization; `src/store/vaultStore.ts`; `src/store/activityStore.ts`; `src/store/libraryCache.ts`.

The owner's installed version is not yet known. These compatibility findings must be checked against it; do not assume all older export shapes match this revision.

## Slicksync observations

The reference has group addon lists, membership expiry, viewing history, recommendation logic, and catalog delivery. Its source is useful for discovering edge cases, not evidence that a direct port is safe.

| Observation | Pinned source | Design response |
| --- | --- | --- |
| Group members are stored as JSON user-ID lists | `prisma/schema.sqlite.prisma`, `Group` | Use constrained membership records/foreign keys |
| Desired-state code explicitly distinguishes no group from an empty group | `server/utils/sync.js`, `getDesiredAddons` | Preserve this distinction and add a separate destructive-empty guard |
| Some sync comparisons sort fingerprints, making ordering a separate concern | `server/utils/sync.js`; `server/routes/groups.js` | Compare configuration and order; test pure reorders |
| Expiry attempts to clear addons, then removes group membership and deletes the user; failure to clear is logged without necessarily preventing deletion | `server/utils/userExpiration.js` | Retain records; keep retrying/alerting until removal is verified |
| Recommendation code documents sparse history/duration data and uses fallback weights | `server/utils/recommendationEngine.js` | Report data quality; do not label estimated watch time as exact |
| Metrics and live presence use different data sources | `server/utils/metricsBuilder.js`, `server/utils/activityMonitor.js`, README | V2 needs a source-to-metric matrix before promising parity |

## Checks performed on the unmodified baseline

Environment: Windows, Node `v24.14.0`, npm `11.9.0`. Installed the lockfile with `npm ci --ignore-scripts --no-audit --no-fund`. Skipping lifecycle scripts was sufficient for these frontend checks; it does not establish native SQLite runtime readiness.

| Check | Result |
| --- | --- |
| `npm run build` | Passed TypeScript compilation and Vite production build |
| Bundle output | Main chunk about 1,207.64 kB raw / 351.43 kB gzip; mixed static/dynamic import warnings |
| `npm run lint -- --format json` | Failed: 2 errors, 7 warnings across 160 inspected files |
| `npm audit --omit=dev --json` | 19 affected dependency entries: 2 critical, 12 high, 4 moderate, 1 low |
| Automated application tests | No test script/suite present in AIOManager baseline; CONTRIBUTING also documents this |
| Docker / PostgreSQL / live Stremio/device behavior | Not tested; Docker executable unavailable in this local environment |
| Production migration / expiry / load | Not run |

Lint errors: `src/components/WhatsNewModal.tsx:193` (`no-useless-escape`) and `src/lib/utils.ts:237` (`prefer-const`). Warnings concern hook dependencies and unused variables. Resolve them with appropriate behavior checks; a passing build does not resolve them.

The audit count is a dependency report, not 19 demonstrated production exploits. The critical entries involve `shell-quote` and its dependent `concurrently`, which is currently listed as a production dependency despite being development tooling. Triage reachability and move development-only packages appropriately; update affected runtime packages in tested changes. No automatic audit fix or dependency update was performed.

Deployment review also found an upstream Node 20 Docker build using `npm install`, a Compose file creating PostgreSQL while `.env.example` defaults to SQLite, and a publication workflow containing the upstream Docker Hub image name. Establish the actual production DB, lockfile-based builds, supported runtime, and fork-owned image publishing before a release. Do not assume the presence of a PostgreSQL container means the app uses it.

## External behavior still to verify

The official [addon protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html) defines catalog resources, and [advanced usage](https://stremio.github.io/stremio-addon-sdk/advanced.html) documents per-user addon configuration. These support a V2 personal catalog design; they do not specify transactional account addon updates, API rate limits, or instantaneous client refresh.

Use disposable accounts to verify collection clearing, official/Cinemeta handling, manifest normalization, update propagation, auth errors, and device cache behavior. No documented provider-side compare-and-swap contract or guaranteed rate allowance was established in this review. Architecture must not depend on either.
