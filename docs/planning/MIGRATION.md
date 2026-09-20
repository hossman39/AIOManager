# Existing-client migration and recovery plan

Status: design/runbook, not an executed migration. Scope is confirmed: email/password only from the owner's current self-hosted AIOManager, into a fork on the same VPS Docker/Portainer stack. No production credentials or data are required in the conversation. Validate the actual export envelope and deployed database before integration/cutover.

## 1. Migration objectives

Keep the same Stremio identities. Extract email and password, preserve passwords exactly, and default display name to email. Ignore old names, auth tokens, dates, notes, colors, and history. Migration must not create Stremio accounts, alter provider watch history, or reset passwords. Account creation remains a separate, preserved onboarding feature.

Existing addons, libraries/profiles, Vault entries, and automation rules are ignored. Group activation uses the newly configured group plus personal addons and safe-mode policy. Safe mode defaults on, retaining existing protected/default entries, especially Cinemeta; first-sync choices control destructive replacement. Pre-write snapshots support rollback without importing old addon configuration as the desired setup.

Separate importing records, assigning proposed groups/expiry, and activating management. Only activation authorizes writes. Even a past expiry selected during staging must remain passive until activation previews the consequence. Expiry disables retained addon records; it must not delete their saved configuration.

## 2. Source inventory

Before selecting an import adapter, record:

- Installed version/build, deployment type, actual database engine, and source application origin.
- Number of client accounts and any duplicate/alias records pointing at one provider identity.
- Availability of a Settings export, cloud sync, and working saved account credentials.
- Which rows lack saved passwords, requiring completion by the administrator before activation.
- Whether old Autopilot/restoration or other managers will continue writing to accounts during cutover; their rules are not imported.
- Client devices/platforms and one disposable test identity for each distinct configuration.
- Existing backups, encryption-key location, and ability to unlock the source without sharing its password.

Source capture records email/password availability, format/version, timestamps, and integrity checks. Credential details remain encrypted or redacted in reports. New groups and personal addons are configured separately; group manifest URLs are identical across members in V1.

## 3. Supported source routes

| Route | Purpose | Limits and handling |
| --- | --- | --- |
| AIOManager Settings JSON | Primary email/password source | Export with credentials included; current envelope is version 2.0.0; auth tokens and other fields are ignored |
| Legacy account array or unversioned accounts envelope | Passive compatibility route | Extract the same email/password allowlist; reject unknown explicit versions |
| Existing server/browser backup | Recovery of the original manager if needed | Retained separately; the destination does not import its addon configuration or share its live database |

Import Settings JSON, complete missing passwords, assign new groups, and activate with safe mode enabled. Missing addon manifests, Vault data, or profiles cannot block valid credentials. Encrypted cloud-state imports and supplemental history adapters are not part of V1 migration.

Support identified envelopes with synthetic tests and validate the owner's actual export locally in rehearsal. Unknown formats/versions require a reviewed adapter. Missing auth keys do not matter; missing passwords require completion. Never guess that a long password is ciphertext.

## 4. Wizard stages

### A. Capture and validate

Retain the original user export and the source's existing recovery material. Keep the current manager operational during passive preparation. Store sensitive exports locally with restricted access and encrypt retained copies. Do not run the ordinary upstream import routine as the preview parser, because it also imports addon/rule state and starts follow-up synchronization.

The passive parser extracts only email/password/default name plus source row numbers. It performs no store mutation, login, webhook activation, manifest fetch, or provider write. Bound file size to 10 MiB and rows to 10,000; validate record shapes, email/password types, and duplicates. Passwords are never trimmed or normalized. Error messages use row numbers and fixed text, never raw input or JSON parser exception messages. An empty export is valid and produces no work.

Use an explicit user-field allowlist. Addon lists, profiles, Vault addon keys, webhook configuration, and automation payloads are ignored, including when bundled into the same source file. Validate required user references independently. Do not interpret unknown fields as executable policy.

### B. Stage records

Persist inactive records and a batch transactionally using destination-generated IDs. Retain keyed source fingerprints and row mappings for idempotency; do not import old IDs or their references. Re-import must not duplicate users or replace an existing saved password without explicit conflict resolution. This durable staging layer is separate from the passive parser.

Within an export, detect trimmed/case-folded duplicate emails conservatively; retain original email case for login. Identical email/password pairs can share one staged candidate with all source rows recorded. Different passwords block every valid-credential row for that email until resolved. Missing/invalid password rows remain explicitly reported. Before activation, verify provider subject identity through bounded login/read-only checks. Email alone never authorizes merging an existing managed identity.

The Settings export supplies plaintext passwords only when credentials were included and previously saved. Encrypt selected credentials with the destination key before durable staging. Never log successful parser results because they contain passwords. Keep upload buffers short-lived and encrypt retained originals; do not copy ciphertext and assume a different key can read it.

### C. Account-by-account reconciliation

Show a report with source/destination totals and status per category:

| Category | Required result |
| --- | --- |
| Email/display name | Email retained (outer whitespace trimmed); display name defaults to email |
| Password | Exact value captured and encrypted before staging, or explicit completion/conflict issue |
| Source auth tokens, names, IDs, notes, colors, history | Ignored; runtime login creates a new session only when explicitly validating/activating |
| Expiry | Unset on import; administrator selects exact New York date/time; never infer import date + one year |
| Lifetime | Explicitly selectable after import; a missing source date never silently becomes lifetime membership |
| New group assignment | Selected in bulk or individually; no group is inferred from old addons |
| Safe-mode policy | New fork default enabled; legacy protected flags are not silently adopted |

Rate-limit any read-only provider identity checks. If unavailable, retain staged records with unknown validation status. Compare live addons against the new group's desired state only when previewing activation, not against a discarded addon export. Never change provider library/watch-state endpoints as part of migration.

### D. Assign newly configured groups

Create the desired groups in the fork and offer bulk assignment of imported users. Do not build addon-preservation adapters, infer membership from previous addons, or require source profiles. Show the resulting group and safe-mode policy for each selected account.

V1 group URLs are identical for all members. Configure optional individual addons separately; never infer them from old addons or copy another client's personal configuration.

Provide per-user exact New York expiry entry, with bulk assignment only if supported by the implementation. Show unassigned accounts, unresolved credentials, and already-expired dates. Do not expand credential migration to date/history imports.

### E. Rehearse restoration

Restore the destination backup into an isolated instance with all writes disabled. Verify user-record counts, references, credential decryption, new group policies, and queued job reconstruction. The unchanged source/export remains available for migration recovery. Backup success means a successful restore, not just that a file was created.

Use synthetic data in CI. Actual migration artifacts stay outside the repository and CI. The local default ignore rules do not protect arbitrary JSON exports, so never save those into the worktree.

### F. Activate progressively

First use disposable/test identities and confirm actual device behavior. Before activating a live cohort, disable legacy Autopilot/restoration and close old manager sessions that can write to those same identities. Do not enable the new writer against a shared copy of the old database.

Take a fresh read-only snapshot before overwriting and show changes to the group's/personal setup under safe mode. This supports recovery, not addon migration. Refresh stale previews. Activate only validated mappings; group/personal revision, safe-mode policy, expiry, and activation must correspond to the preview.

Suggested progression: test accounts, 2-5 client accounts, then one group-sized wave at a time. The owner selects live pilot clients and the maintenance window after reviewing the tested release and exact diffs. Migration activation is an operator action in the delivered product; it is not implied by importing a file.

Observe for at least a day after the first live cohort and exercise controlled expiry/renewal on test accounts. Widen only after successful verification, no unexplained drift, and no unresolved account losses. Tune observation time to actual usage; elapsed time alone is not evidence of correctness.

## 5. Preventing competing writers

For each activated identity, record which system is responsible and when ownership transferred. Gate legacy saved-addon propagation, account/bulk edits, generic proxy writes, failover, and restoration in the new app. Disable those paths in the old running manager for transferred identities.

Old browser tabs and a legacy backend are independent writers; a new database lock cannot control them. If disabling the relevant legacy paths selectively is not possible, the cutover must pause that manager's automation globally before activating the new cohorts. This dependency must be resolved in rehearsal, not discovered with clients live.

Keeping the old manager available for recovery is useful, but its writers remain off while the fork owns an identity. Never point two managers at the same active SQLite file or allow both to enforce different desired addon lists.

## 6. Recovery procedures

### Individual account or bad group publication

1. Pause the affected deployment; drain or explicitly resolve in-flight calls.
2. Select the prior published revision or pre-change account snapshot and generate a restoration preview.
3. Check current entitlement, membership, configuration bindings, and remote state. An expired account cannot be re-enabled by a generic restore action; renewal is a separate policy change.
4. Publish restoration as a new revision/job using normal authorization, snapshots, rate limits, and verification.
5. Report each account's result. Preserve failure evidence and keep affected rollouts paused if verification fails.

Restoration repairs configuration controlled by this manager. It does not revoke or undo already-issued stream URLs, reverse external provider actions, or atomically rewind Stremio devices.

### Application release rollback

Pause all outbound work, wait for the writer to drain, preserve current DB/key material, and roll back the application image only if schema compatibility is explicitly tested. Use additive migrations through the rollout period. Never assume an old binary can run a newly migrated DB.

Restoring an older database reintroduces older queued work and potentially stale expiry dates. Boot restored instances in recovery mode with writes disabled; reconcile revisions, renewal changes, and remote state before resuming. Encryption keys must come from the matching recovery material, not a new auto-generated key.

### Return to the original manager

Stop fork writers and account automation first. Restore the original manager against its own source backup and original encryption material in an isolated check. Preview remote addon differences, then hand back identity ownership deliberately. New groups/expiry fields are not understood by the old app; preserve them in the fork recovery kit. Returning to the old manager removes automatic expiry enforcement until an alternative is active, and this must be clearly reported.

## 7. Migration completion criteria

- Every source account is accounted for as activated, staged intentionally, or blocked with a specific reason.
- Email/password inventory reconciles, names default to email, and every missing/conflicting credential has an explicit status.
- No silent credential substitution, user loss, or unintended provider-history change occurred.
- Legacy addon/library/rule payloads were ignored; missing addon data did not block valid users.
- Activation applied the new groups with safe mode enabled by default and the agreed exceptions verified.
- Repeated import and server/browser restarts do not duplicate accounts, rules, or operations.
- The activated cohort's remote collections match the approved policies, verified per account.
- Old and new writers do not compete for the same identities.
- Destination recovery material has been restored successfully in isolation; original user exports remain recoverable.
- A report records revisions, mappings, counts, and outstanding items without containing credentials.
