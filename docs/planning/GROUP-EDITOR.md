# G3 authoring UI plan

The existing managed APIs are the only write path used by these screens. Do not
call legacy account stores, collection APIs, Autopilot, or browser-side loops over
Stremio accounts. Provider writes remain off throughout this increment.

## Implementation order

1. Pure addon draft operations and a reusable controlled editor. Keep full JSON
   extension fields; mutate only the selected setting. Preserve exact configured
   URLs and same-ID/different-URL entries. Reject exact-URL duplicates. Metadata,
   catalog rename/order/visibility, enabled/protected flags, addon order and all
   three Cinemeta options are first-class controls, not a URL-only replacement.
2. Versioned group create/select/save/preview/publish with fixed errors and exact
   retry keys. Preview only a saved draft. Any edit invalidates displayed preview;
   stale server responses cannot replace newer local edits. Show empty consent and
   affected active/expired/staged/offboarding counts. Saving a draft never publishes.
3. Recorded rollout status, passive assignment from loaded inventory, and personal
   addon editing using the same controlled editor. Preserve one-group ownership;
   no migration of source addon data. Activation remains a separate disabled path.
4. Synthetic browser rehearsal, including lost-response retry, conflict/reload,
   customizations, disabled entries, empty publication, assignment, personal
   collisions, mobile/keyboard interaction, and zero provider collection writes.

## Editor invariants

- Edits are transient until the parent saves. Never store configured URLs or
  manifests in localStorage, analytics, console output, or navigation query strings.
- Existing descriptor fields survive byte-significant JSON round trips. Clearing
  an optional metadata override removes its key rather than inserting undefined.
- A network manifest read is explicit (add/replace/reset). A failed read does not
  alter the existing draft. Refreshing catalogs is separate from updating the
  entire addon and preserves flags, metadata and unrelated extension fields.
- Keep disabled addons visible. Disable is not removal. Removal is explicit and
  blocked for protected entries until the operator clears their protection.
  Official/Cinemeta entries start protected. No group template change silently
  bypasses effective safe mode on an actual client.
- Catalog visibility uses the source's ID-based removed list; if the same catalog
  ID exists for several types, explain that hiding that ID affects all of them.
  Keep descriptors so a hidden catalog can be restored without a network read.
- Keep an unmodified base manifest and store Cinemeta's three choices as retained
  intent. The managed worker must apply the tested source transformation during
  projection, not destructively overwrite the base or saved enabled preferences.
- Advanced JSON is optional, validated, and explicitly applied. It must not be
  required for ordinary customization or silently discard unsupported extensions.
- No unchecked asynchronous fetch may replace a newer draft after editing,
  switching users/groups, cancellation, or unmount. Disable competing edits while
  a manifest is being resolved and capture its target identity.

## Write and retry behavior

Capture a cloned payload and unique key before sending a mutation. A timeout or
unexpected response freezes the submitted values and offers retry of exactly
that operation. Explicit conflict requires reload before another write. A replay
acknowledges the old operation; fetch current state before displaying it as current.
Do not invent success from an HTTP request merely starting. Pending publication
is not verified provider state, especially while writes are disabled or paused.

Warn on leaving unsaved or ambiguous work. Closing an editor must not silently
publish, discard a pending outcome, or change account membership. Keep focus,
labels, keyboard controls, and small-screen layout usable without hover or drag.

## Test boundary

Unit-test pure transformations and submission-state rules, run existing API and
compatibility regressions, and rehearse against a fresh synthetic server. This UI
does not establish provider, Android, backup, scheduler, or ownership-gate evidence.

## Navigation hardening (browser finding)

The first browser rehearsal found that `beforeunload` alone does not protect SPA
links, keyboard navigation, or browser history. Use one aggregated blocker for
all dirty/pending managed editors, with explicit Stay / Leave controls and the
native unload warning for reloads and external navigation. Logout must use the
same warning; security-driven vault locking must not be delayed.

Adopt the documented root-splat `createBrowserRouter` wrapper, retaining the
existing route tree, auth guard, lazy loading and URL paths. No package upgrade,
route loaders, server actions or route rewrite is needed. Preserve router-owned
history state when legacy code updates bookmark query/hash values, otherwise Back
cannot be reliably restored after a blocked transition. Rehearse Back/Forward,
link/keyboard navigation, Stay/Leave, logout cancellation, direct URLs, and existing
tabs. Unit-test aggregation and router history transitions. References:
[incremental router wrapper](https://reactrouter.com/6.30.1/upgrading/v6-data)
and [navigation blocker](https://reactrouter.com/api/hooks/useBlocker).

Rollout recovery must also survive reload/group selection: add an owner-scoped
read of the deployment for the group's published revision, using the existing
unique group/revision index. Render only the selected group's progress, abort
stale reads on selection changes, and recover it from the server rather than
localStorage. Unpublished is explicitly null; a missing published deployment is
an integrity error, not an empty success. Cover tenancy, restart and switching
groups before considering the authoring checkpoint complete.

## Implemented evidence (2026-09-20)

- Six draft-operation tests retain full metadata/catalog/Cinemeta/URL/flag data;
  two submission tests cover exact captures and failure classification; three
  navigation tests cover aggregation, cleanup and installed-router history.
- Rollout discovery adds two common database contracts (SQLite and PostgreSQL),
  one client case, and assertions in authenticated HTTP and file-backed restart
  cases. Missing published deployment data never becomes an empty success.
- Full local suite: 225 passed, zero failures; 72 PostgreSQL cases reserved for
  hosted CI. Typecheck, lint and production build pass. Both production dependency
  audits report zero known vulnerabilities. No dependency or schema change in
  this increment. Baseline chunk-size/dynamic-import/Browserslist warnings remain.

Browser rehearsal uses fresh temporary SQLite databases, synthetic credentials,
and fake manifest transports (`--seed-groups`). Real Stremio/provider transports
are disabled. The following were exercised, not inferred from unit tests:

1. Create/save/publish a group. Preserve custom name/description, catalog name and
   hidden catalog, Cinemeta options, protected default, addon order and a disabled
   addon. Save is distinct from publication; protected removal is disabled.
2. Lose a successful publish response, then retry. The second request has exactly
   the same body/key and produces revision 1, not a duplicate. The ambiguous form
   stays frozen and never claims verified provider work.
3. Assign three staged users atomically without activating them. Reject a personal
   URL already in the group; keep the draft for explicit correction. Save a
   distinct personal addon disabled, lose the response and retry the same body/key.
   Its disabled descriptor survives reload.
4. Simulate a competing group save. The old version is rejected, retains local
   edits, and cannot save again until explicit reload. An entirely disabled
   publication requires consent and retains its addon descriptor.
5. App-link, Back, Forward, logout and keyboard-navigation warnings. Stay retains
   work; Leave actually navigates without saving; returning loads only saved data.
   Recheck a lifetime membership save after the router change. Ordinary navigation
   works again when no editor is dirty. Keyboard chord events were dispatched
   together because separate browser-tool calls exceed the existing 500ms chord
   timeout. Physical/native browser controls still need hands-on acceptance.
6. At 390x844, expanded group customization initially exposed one long-button
   overflow; wrapping it fixes document width to 390px with no editor-control
   overflow. Inventory intentionally scrolls horizontally. Wrong-addon URL
   replacement fails without changing the original disabled entry. Unapplied
   URLs disable save/close until resolved or explicitly cleared.
7. Read a pre-published group's recorded status, reload and recover revision 1
   without publishing again. Delay a progress response and switch to an unpublished
   group: the old response cannot replace its explicit unpublished status. No
   console errors/warnings in that final rehearsal.

Temporary rehearsal data is removed by the helper's validated cleanup, never by
deleting a real database. Route smoke checks include managed users, Accounts,
Settings, FAQ and Activity; Metrics/Replay lazy routes were reached but their
analytics and share-link behavior still need full feature acceptance. No real
Android/provider rollout, backup restoration, live expiry or load/soak behavior is
established here. G3 authoring is a development checkpoint, not release approval.
