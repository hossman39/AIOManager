# AIOManager 2.3.2 public deployment review

## Findings and changes

| Area | Finding in the previous release | Change in 2.3.2 |
| --- | --- | --- |
| Autopilot | The legacy routes trusted account or rule IDs for operations on saved rules, history and webhooks. | Every route authenticates a manager. The server binds each account to one owner and checks the rule's account on updates and deletion. The original unlocked vault can bind its existing rules using the stored provider credential. |
| Outbound HTTP | Legacy relays and webhooks accepted destinations after limited hostname checks. Metadata responses could serve upstream content under the manager's origin. | The server checks DNS answers and pins the connection to permitted public addresses. Redirects are revalidated. Size, time and queue limits apply. Metadata returns parsed JSON and the public poster relay accepts raster images from the supported poster domains. |
| Provider credentials | The metadata relay could forward the inbound Authorization header. Addon URLs containing credentials could appear in reverse-proxy query logs. | The UI sends addon/provider destinations in POST bodies. The relay forwards an explicit provider token only to a supported HTTPS provider origin. Redirects across origins drop credentials. |
| Browser and vault | Release notes were converted from remote text into HTML. The cloud sync password remained in persistent browser storage. | React renders release notes as text and links. Operator-supplied login banners run in a sandboxed frame. The manager password is scoped to the unlocked tab, and the app scrubs legacy persistent copies when the browser loads the update. |
| Public API | An anonymous caller could register another manager identity on a production server. Several relays accepted anonymous requests. | Production registration requires explicit opt-in. Existing managers retain client enrollment. Manager authentication protects the provider and health relays. Repeated failed logins are throttled per manager and socket peer. The expiry notice stays public. |
| Container and dependencies | The previous image included package-management tooling and operating-system packages unrelated to serving the app. Development dependencies had known advisories. | The runtime contains Node, server dependencies and their required libraries. It runs as UID/GID 1000. Release checks cover dependency audits and the packaged Linux images. |

## Verification on the release candidate

- The full Windows test run passed 377 tests. All 152 PostgreSQL tests passed against a disposable PostgreSQL 16 database in a separate run. Type checking, lint, the production frontend build, Compose validation and the OpenAPI comparison passed.
- Chromium signed in to an existing synthetic manager, reloaded the page and retained the unlocked session. The saved manager record contained no password in persistent local storage. Regression tests also cover migrations from older browser storage, owner isolation, login throttling, backups and the public notice.
- A Docker upgrade rehearsal used the published 2.3.1 image, a fresh volume and synthetic data. Version 2.3.2 preserved the manager login, encrypted sync record, managed account ID, group assignment and membership. The original manager could claim its legacy Autopilot rule. Separate container restarts verified HTTP access and SQLite persistence under UID 1000 with external networking disabled on both AMD64 and emulated ARM64.
- Both npm lockfiles reported zero known dependency advisories. Trivy scanned the assembled AMD64 and ARM64 images. Each image reported zero critical or high findings and zero detected secrets. Each had 21 medium, 12 low and two unclassified Debian package findings, with no fixed package version listed. These are package findings, and one advisory can apply to multiple runtime libraries. The Dockerfile configuration scan also flagged a build-time change of working directory while copying runtime libraries.

GitHub also ran the Linux containers on native AMD64 and ARM64 runners. The release workflow passed on both platforms and the Windows, Linux and PostgreSQL jobs passed. An anonymous registry read verified that version `2.3.2` and the build's SHA tag resolve to the same image index. A second scan of each published architecture reported zero high or critical findings and zero detected secrets. [Release workflow](https://github.com/hossman39/AIOManager/actions/runs/45557280932)

## Deployment boundary

Nginx Proxy Manager terminates TLS. Check Force SSL, certificate renewal, the network path to the backend, and access restrictions for the proxy dashboard on the actual host. Anybody who can reach the raw backend port can bypass proxy restrictions. On a containerized proxy, a shared private Docker network allows the proxy to reach AIOManager without publishing its port on the Internet.

Treat the browser tab, manager sync token, application data directory, backup credentials, reverse proxy and Docker host as trusted. A host administrator with both the database and encryption key can access managed credentials. Store a recoverable copy of the key and restrict access to logs and snapshots. Public expiry notices contain the contact information chosen by the manager. Their URLs are intended for installed clients.

The review covered the fork's server, client, dependencies, production image and deployment configuration. Testing used disposable accounts and databases. Production TLS, firewall rules, other containers, provider infrastructure and historic access logs require access to the deployed environment. The exposure identified in source code does not establish whether anyone accessed a real account.

The release procedure and backup/rollback steps are in [the deployment guide](../DEPLOY.md). The outbound-request and response-header checks follow the [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) and [OWASP HTTP headers guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html).
