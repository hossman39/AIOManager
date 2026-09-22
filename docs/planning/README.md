# Managed AIOManager fork: planning package

This directory preserves the design decisions and historical implementation
checkpoints. Version 2.0.0 is implemented, verified and published. Start with
[implementation progress](PROGRESS.md) for current evidence and
[the deployment guide](../../DEPLOY.md) for launch. Android TV acceptance is planned
for the live environment; API client integration and whole-server backups are deferred.
The earlier milestone descriptions below are historical, not outstanding work lists.

The priority is reliable management of existing paying clients. V1 covers migration from AIOManager, automatic group addon management, and per-account expiry and renewal. V2 covers expanded viewing metrics and personal recommendation catalogs.

Owner clarification: migrate email and password only, using email as the display name. One group plus individual account addons determines the managed setup. Safe mode is enabled by default and retains the base project's protection behavior; expiry overrides it. See the authoritative [owner decisions](DECISIONS.md) before earlier design proposals.

## Read in this order

1. [Owner decisions](DECISIONS.md), then [evidence and baseline](BASELINE.md): confirmed behavior and the source inspection.
2. [V1 specification and delivery plan](V1-SPEC.md): behavior, architecture, decisions, milestones, and acceptance criteria.
3. [Migration and recovery](MIGRATION.md): preserving existing clients, previewing changes, staged cutover, and rollback.
4. [Verification and release gates](VERIFICATION.md): failure scenarios, performance targets, and evidence required before rollout.
5. [V2 roadmap](V2-ROADMAP.md): metrics inventory, data limitations, and private recommendation catalogs.

## Original repository baseline (2026-09-19)

- Existing GitHub fork: [hossman39/AIOManager](https://github.com/hossman39/AIOManager). It already existed and matched upstream when inspected.
- Base: AIOManager 1.8.5, build 2, commit `dfbbc3412c1928554670d27457fd4983de59dbe8`.
- Local planning branch: `planning/managed-groups-v1`.
- Remotes: `origin` is the existing personal fork; `upstream` is Sonicx161/AIOManager.
- Slicksync is a separately checked-out reference, not an imported codebase.
- Development-branch checkpoints and CI are separate from release. No production accounts were accessed, migrated, or modified, and no deployment was performed.

## Confirmed scope

The owner's answers are recorded in DECISIONS.md. V2 is deferred. Expiry disables every addon while retaining its saved configuration; renewal lifts suspension while respecting manually disabled entries. Disabled entries are omitted from Stremio's active collection, matching upstream behavior. Backend service revocation is out of scope. No further product clarification is blocking the local foundation work.

| Decision | Proposed starting point | Why it matters |
| --- | --- | --- |
| Group membership | One group plus separately configured personal addons | Confirmed |
| Safe mode | Existing protections; global default/group overrides; next-sync changes; expiry overrides all | Confirmed |
| Addon credentials | Configured manifest URL identical across group members | Confirmed |
| Expiry/renewal | Per-user exact date and time in New York; Expired system view; restore original group/current personal configuration | Confirmed |
| Deployment and scale | Existing VPS / Docker / Portainer; 40 now, 60-100 next year | Confirmed |
| Providers | Stremio / Android for V1 | Confirmed |
| Migration | Email and password only; exact input format validated from export | Confirmed |

Daily snapshots and test accounts are confirmed. External notifications, billing integration, and V2 decisions are deferred. Do not add those requirements to the initial migration.

No plan can establish that software has zero bugs. Release requires evidence for the specified invariants, successful recovery rehearsals, and staged observation. External API or device failures must remain visible and recoverable.
