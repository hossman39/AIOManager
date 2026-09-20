# Owner decisions: V1 implementation contract

Recorded 2026-09-19 from the owner's numbered answers. These decisions supersede earlier proposals in this package. V2 questions are deferred. The application remains a fork of AIOManager: existing addon customization and account creation are compatibility requirements.

## Confirmed requirements

| Area | Decision |
| --- | --- |
| Migration | Email and password only. Default the manager's display name to the email. Do not import old addons, profiles, rules, auth tokens, or history. Flag accounts without a saved password for completion. |
| Source | Owner runs the latest AIOManager on their own server. Verify the exact export version from the file before parsing. |
| Deployment | Existing VPS, existing Docker stack managed with Portainer. No platform migration. |
| Scale | About 40 clients now; design/measure for 60-100 within a year. |
| Provider | Stremio on Android for V1. Keep provider boundaries extensible; do not implement Nuvio now. |
| Groups | One group per active client. Support separately configured individual addons on each account, including testing use cases. |
| Addon configuration | Accept configured manifest URLs from the addon's own app. Preserve AIOManager's editing/customization features. Group members share the same manifest URL in V1. |
| Publication | Edit a draft, then publish once to automatically schedule every eligible group member. |
| Client changes | Do not add periodic enforcement that reverses ordinary client edits. Preserve the source's protected-addon behavior. |
| Protection | Safe mode on by default; protect default/protected addons, especially Cinemeta. Keep existing protection/customization semantics. |
| Safe-mode scope | Global default with group overrides, plus the account's first-sync choices. Disabling safe mode allows the relevant destructive/reorder/edit operations. |
| Safe-mode changes | Take effect on the next sync. No additional publication/confirmation workflow solely for a protection change. |
| Expiry | Exact per-user date/time in `America/New_York`; disable every addon, overriding protection and including individual addons. Never delete saved addon records/configuration as an expiry action. |
| Lifetime membership | Explicit per-user lifetime option, confirmed in the follow-up request. Lifetime users receive normal group/personal updates but have no automatic cutoff. Missing imported dates are not automatically lifetime memberships. |
| Expired clients | Retain user credentials/configuration for renewal. Show an Expired system group/view and keep the former active group assignment for restoration. |
| Renewal | Edit the user's expiry date/time or explicitly choose lifetime. Either a future date or lifetime lifts expiry suspension and syncs the current group plus individual/default/protected setup, respecting intentionally disabled entries. |
| Removal | Clear remote addons and verify completion before deleting the local account record. Failed cleanup retains credentials and a visible pending/error record. |
| Account creation | Preserve adding/creating new Stremio accounts. Migration is a separate import workflow and must not silently create replacements for failed logins. |
| Testing | Dedicated test accounts/devices are available. Do not use paying accounts for fault/load tests. |
| Backups | Automatic daily snapshots. Pre-change recovery snapshots remain part of safe execution. |

## Implementation details derived from those decisions

- Personal addons are explicit account configuration, not automatically inferred from ignored migration data. Publishing a group must not erase those additions. The same addon ID can appear with multiple configured URLs.
- Preserve group order and a separate personal-addon order. Default personal entries to follow the group; retain the existing UI's supported reorder capabilities when wiring the editor. Conflicting edits/duplicate exact URLs must be visible, not silently assigned another credential.
- Initial provisioning, explicit sync, group publication, expiry, renewal, and cleanup jobs are durable. Automatic retries recover a requested change; there is no new blanket periodic group-drift rewrite.
- Expiry remains enforced after the deadline; neither a group publication nor existing Autopilot/restoration may re-enable an expired account. This is distinct from respecting ordinary edits on active accounts.
- Model expiry as an account-level suspension over saved addon enabled preferences. Effective entries are all disabled while expired; saved URLs, manifests, metadata, catalog choices, order, protections, and enabled preferences survive. Renewal removes the suspension, not blindly enables every entry. Preserve intentionally disabled addons, including changes made while expired.
- Unassigned new/imported records remain staged with no provider write. Removing an already-managed client is an offboarding action that clears addons first. A transfer to another group applies the destination setup without deleting the client.
- The Expired system view is based on entitlement, not a normal empty addon template. Keep the prior group ID rather than destroying it by moving the account into an ordinary group named Expired.
- Use exact timestamp cutoffs, not an inferred end-of-day date or annual anniversary. Default to no grace period. Reject nonexistent New York wall times at the spring clock change; require explicit resolution of repeated fall-back times.
- Store imported passwords and runtime session keys encrypted at rest. Never trim/normalize a password or expose it in a validation error, application log, or test artifact.
- Email is the default display label. There is no separate provider username to migrate. Existing optional account naming need not be removed from the base UI.
- Use existing manager authentication and administrator access for the first implementation. Staff/customer portals and external notifications are deferred unless requested.
- Keep a failed offboarding record until remote removal is verified. Retain only necessary non-secret job/audit tombstones after deletion to prevent stale work from reviving it. Expiry itself does not delete the user.

## Confirmed expiry boundary

The owner clarified that expiry must use the existing disable behavior, not delete addons. Upstream `toggleAddonEnabled` retains saved descriptors with `flags.enabled = false`; `updateAddons` omits disabled descriptors from the active collection sent to Stremio. V1 preserves this distinction: retained disabled manager records, no active remote addons, and no manager-driven reactivation until renewal. Do not replace the saved collection with `[]` or call the addon deletion path for expiry.

Only the administrator has manifest URLs, so no underlying addon/provider access-revocation integration is required. Device caches and already-playing streams remain external limitations; do not claim disabling addons forcibly terminates playback or locks the Stremio login. Offboarding/deleting a client is a separate workflow requiring verified cleanup before local deletion.

## Immediate engineering increment

Before connecting new automation to any account: establish automated compatibility tests for current protected-addon behavior, addon metadata/catalog customization, Stremio account creation, and credential handling; resolve baseline lint issues; implement/test the passive email/password import parser. No production endpoint or account is needed for this work.

Then implement durable authenticated persistence/workers, group UI with personal addons, exact New York expiry suspension and renewal, and verified offboarding. Keep live writes disabled in development and retain the release gates in VERIFICATION.md. Daily container backups, real Android behavior, and actual VPS database/runtime checks remain integration/release work.
