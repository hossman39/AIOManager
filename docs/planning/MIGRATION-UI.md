# Passive migration screen checkpoint

`/managed` is a separate, lazy-loaded workspace linked from desktop and mobile
navigation. It uses the current manager's authenticated sync server. Staged records
never enter the legacy browser account store, so its automatic refresh/Autopilot
cannot activate newly imported users.

The browser validates the export and strips everything except email/password before
requesting a server-side preview. Row numbers, duplicate/conflicting passwords, and
missing credentials retain the same parser semantics. A separate Save inactive
users action persists encrypted records after the operator acknowledges server-side
credential storage. The same idempotency key is retained on ambiguous retries.
Passwords remain transient, are not rendered, and are not placed in localStorage,
sessionStorage, or the legacy persisted account stores.

Cancellation, success, unmount, and owner/server changes discard the import payload
references. JavaScript garbage collection is not a guaranteed memory wipe. Responses
are schema-validated, unexpected secret fields are stripped, and exception messages
are mapped to fixed UI text. Requests omit cookies/referrers, disable caching, and
reject redirects so custom authentication headers are not forwarded elsewhere.

Absolute custom sync-server settings follow the source store's server-root
convention: append `/api`, preserving any deployment subpath. An explicitly supplied
`/api` suffix is not duplicated. A client regression test covers both forms and
same-origin relative API paths; production credentials are never used in this test.

## Evidence

- Seven client tests cover upload allowlisting/row fidelity, exact password bytes,
  auth headers, redirects, error redaction, invalid responses, and cancellation.
- Browser rehearsal used an isolated browser context and a fresh loopback server
  with temporary data and rejecting provider transports. No existing database or
  Stremio account was accessed.
- A six-row synthetic upload produced two inactive users, one duplicate notice,
  one missing-password notice, and two conflicting-password row notices. Repeating
  the import reused the saved batch; inventory remained two users after reload.
- The password strings were absent from rendered text and localStorage. A 390x844
  mobile emulation had no document-level horizontal overflow. No browser console
  errors/warnings were observed.
- The browser tool could not access the fixture filesystem path; the rehearsal
  instead used an in-memory synthetic `File`/`DataTransfer`. The native OS file
  picker and the owner's actual export still need release rehearsal.
- The temporary server was stopped and only its generated test directory removed.
  Synthetic fixture source remains in the repository for repeatable testing.

This checkpoint passed all hosted checks in
[run 35482177523](https://github.com/hossman39/AIOManager/actions/runs/35482177523).
Subsequent dated/lifetime membership editing is recorded in [MEMBERSHIPS.md](MEMBERSHIPS.md).
Group activation, automated expiry enforcement, and live offboarding remain disabled.
