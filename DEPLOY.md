# Deploy the managed AIOManager fork

Release images belong to `ghcr.io/hossman39/aiomanager`. Use the image digest or
`sha-<full-commit>` from the tested release. Never substitute the original upstream
image for this fork or use an unattended `latest` update.

## Upgrade to 2.3.2

Pull the public image from the fork. Docker selects AMD64 or ARM64 for your host.

```sh
docker pull ghcr.io/hossman39/aiomanager:2.3.2
```

Use `ghcr.io/hossman39/aiomanager:2.3.2` as the image in your existing Portainer
stack. To pin the exact build, use the full `ghcr.io/...` value of
`AIOMANAGER_IMAGE` in [.env.example](.env.example). If your stack already uses
that variable, update its value in Portainer. Follow the backup and upgrade
steps below before redeploying.

In Nginx Proxy Manager, keep the existing SSL certificate and enable **Force SSL**.
Only the proxy should be able to connect to the application port. A containerized
proxy can use the app name and port 1610 on a shared private Docker network.
Keep the Nginx Proxy Manager admin interface private. For a deployment with
private admin access, allow clients to reach the existing public expiry addon at
`/api/notice/*`, including its images and renewal page. Keep admin IP or VPN
restrictions on the remaining routes. A proxy rule on the whole hostname also
covers the expiry addon unless you give that path a public exception.

Keep `ALLOW_NEW_MANAGERS=false` in production. Existing manager sign-in and
adding Stremio or Nuvio customers continue to work. For a fresh manager identity,
temporarily enable registration behind a private admin-only proxy, create the login,
then close registration and redeploy before restoring public access.
The runtime image uses numeric UID/GID 1000 and the Node executable. Run maintenance with the documented Node commands. An interactive shell and npm are available in the build environment only.
Managers using an old open tab should reload once. The app removes the old
persisted password when that browser first opens the updated UI.

Open Autopilot from the original unlocked manager vault so the app can associate
existing rules with their owner. Review existing rules, destinations and webhook URLs.
History without any retained rule cannot be associated automatically. Keep the backup
if you have such history. Legacy Sidekick rewritten URLs are disabled in production
by default. Only deployments using those URLs need `ALLOW_LEGACY_SIDEKICK=true`.
The legacy health and metadata relays and Autopilot webhooks now require a public
network destination. Check any existing LAN-only webhooks or legacy relay URLs.
Managed group manifest validation still has its dedicated, operator-controlled
`MANAGED_MANIFEST_PRIVATE_ORIGINS` setting.
Ordinary managed Stremio/Nuvio addons and expiry notices use separate routes.

Check the manager timezone under **Settings ? Account sync** before resuming sync.
Confirm an existing account displays its expected end-of-day expiry, the Autopilot
rules open for their owner, and a previously installed notice opens on a client
without an admin login. Keep the pre-upgrade snapshot until you have verified
the results. For rollback, stop the new writer and restore the old image plus
the matching database, data volume and encryption key from that snapshot.

## Previous releases

For a rollback, use the version recorded before the upgrade. If the schema
changed, restore the matching pre-upgrade database and encryption key with it.

| Version | Build commit | Image |
| --- | --- | --- |
| 2.3.1 | `9aef2eb` | `ghcr.io/hossman39/aiomanager@sha256:58373a647c246ac991c52f4d54b52e719f0a0957b31218e3d34bb22fade33c17` |
| 2.2.0 | `0e5301f` | `ghcr.io/hossman39/aiomanager@sha256:fb8f40f20264c33cbde665330bb3f318075f613ebedac4222cc8b5a82ba613b3` |
| 2.1.0 | `9c13184` | `ghcr.io/hossman39/aiomanager@sha256:ef17a0333f627c00af87da4c128fe891c61249eeb4af28d53a1c6b9b13848ecc` |
| 2.0.0 | `67395d1` | `ghcr.io/hossman39/aiomanager@sha256:1dec7336720ce1b9d0a1f9bff5be0533d318f3dc7833b54d0e016d4897c37d9c` |

## Existing VPS / Portainer stack

1. Record the current stack definition, image, database engine, port, network and
   persistent mounts. Keep the existing database and encryption-key configuration.
   This is an application upgrade, not a database-engine migration.
2. Pause managed sync and the original manager's overlapping automation. Preserve
   a consistent application database copy and its matching encryption key before
   the schema upgrade. Whole-server backup setup can be handled separately.
3. Set the stack image to the tested fork SHA tag/digest. Retain `DB_TYPE`,
   `DATABASE_URL` when using PostgreSQL, `DATA_DIR`, and existing volumes. Never
   start with a new empty mount while assuming the old data is attached.
4. Set `MANAGED_WRITES_ENABLED=true`, `MANAGED_BACKUPS_ENABLED=true`,
   `LOG_PRETTY_PRINT=false`, and `CORS_ORIGINS` to the app's HTTPS origin. Run one
   writer per database. The container runs as the non-root `node` user (UID 1000),
   so its existing data directory must be writable by that identity.
5. Recreate only the application service. Check its Docker health and
   `https://YOUR-HOST/api/health`; verify existing accounts and Settings before
   resuming sync. The footer identifies the release and build commit.
6. Configure the expiry notice's reachable HTTPS base URL. Allow unauthenticated
   `/api/notice/*` so Stremio can display it. The UI and API keep their own
   authentication. Keep the backend port private to the reverse proxy.
7. On dedicated test accounts, verify group updates, expiry, renewal, the notice
   on Android TV, and a container restart. Observe the initial live cohort before
   moving remaining clients. Device caching is evaluated on the TV itself.

Update the existing Portainer stack definition in place. The fresh-install files
below are not a replacement for its current mounts, networks, database or keys.
An installation using the old bundled PostgreSQL layout needs both Compose files
below, its actual database password, and the same `aio-db-data` directory. Do not
run `down -v` or `--remove-orphans` during the upgrade.

## New installation with Docker Compose

Use a dedicated directory on the VPS. These commands are for a **new** SQLite
installation; existing installations follow the upgrade steps above.

```sh
cp .env.example .env
chmod 600 .env
sudo install -d -m 0750 -o 1000 -g 1000 aio-data
```

Edit `.env`: retain `DB_TYPE=sqlite`, set the app's HTTPS origin in `CORS_ORIGINS`,
and enable `MANAGED_WRITES_ENABLED=true`. The app starts each new manager paused;
resume it from Settings after checking the inventory and first-sync preview.
Leave `ENCRYPTION_KEY` empty only for a new installation: the generated key is
persisted in `aio-data/server_secret.key` beside the database.

```sh
docker compose config --quiet
docker compose pull aiomanager
docker compose up -d aiomanager
docker compose ps
curl --fail http://127.0.0.1:1610/api/health
```

The default host binding is `127.0.0.1:1610`, for a reverse proxy on the VPS host.
If the proxy runs in Docker, connect it to the app's Docker network and forward to
`aiomanager:1610`, or retain the already configured proxy network. Set `HOST_PORT`
only when the host port must differ; the container still listens on 1610. Route
the complete app, including `/api/*`, through the same HTTPS origin. A static file
host cannot run managed sync, expiry or backups.

### Bundled PostgreSQL

The default Compose file starts only the app. To run the bundled PostgreSQL
service, set `DB_TYPE=postgres` and `POSTGRES_PASSWORD` in `.env`, then use both
files for every Compose command:

```sh
docker compose -f docker-compose.yml -f compose.postgres.yml config --quiet
docker compose -f docker-compose.yml -f compose.postgres.yml pull
docker compose -f docker-compose.yml -f compose.postgres.yml up -d
docker compose -f docker-compose.yml -f compose.postgres.yml ps
```

For a **new** database, `openssl rand -hex 32` generates a URL-safe password. Store
it in `.env`. Existing databases must keep their actual password; changing the
environment does not reset a database password. The overlay keeps the original
`aio_user`, `aio_manager`, service name and `./aio-db-data` mount. It does not expose
the database port. If an existing password needs URL encoding or the database uses
different names, retain its existing stack definition and connection string.

For an external PostgreSQL server, use the base file only, set `DB_TYPE=postgres`
and the existing `DATABASE_URL`, and retain its TLS settings. `aio-data` is still
required for encryption keys and application archives with either database engine.

`compose.managed-test.yml` is an isolated test stack, not a production upgrade.

## Live acceptance

- Health succeeds through the final HTTPS hostname. The footer shows `2.3.2` and
  the build commit from the release.
- Existing accounts, memberships and groups are present after a container restart.
- A dedicated Nuvio profile receives the correct group. Under **Follow membership**,
  let a short term expire naturally, refresh addons, and try a fresh title. Renew
  the membership, refresh again, and confirm playback. Check an existing Stremio
  account still receives its group and plays normally.
- Preview and import watch history on a test profile. Check a watched episode and
  a resume point on the TV. Confirm the renewal message is readable there.
- Settings reports the expected application-backup status. Whole-server backup
  infrastructure remains a separate follow-up.

Use the [Nuvio walkthrough](docs/TESTING-MANAGED.md#nuvio-pilot) for the device checks.

## Publish a release image

The **Publish fork image** GitHub Actions workflow runs the full Windows/Linux,
PostgreSQL and AMD64/ARM64 checks before publishing. Dispatch it on this fork's
`main` with `publish=true`. It publishes SHA and version tags, without a `latest`
tag. Record the resulting manifest digest for the deployed stack.

## Rollback

Schema migrations are append-only. An old image must not run over an upgraded
schema. Stop the new container and restore the pre-upgrade database **and matching
keys** with the previous image/mount configuration. Start paused, inspect the
inventory and current Stremio state, and reconcile writes accepted since the
snapshot before resuming. See [the restore walkthrough](docs/TESTING-MANAGED.md).

## Optional API connection

Skip this for launch. No API key needs to be created. The existing integration
controls can be configured later if Box Manager is connected; see
[API.md](docs/API.md).
