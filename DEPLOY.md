# Deploy the managed AIOManager fork

Release images belong to `ghcr.io/hossman39/aiomanager`. Use the image digest or
`sha-<full-commit>` from the tested release. Never substitute the original upstream
image for this fork or use an unattended `latest` update.

## Nuvio rollout with 2.1.0

Transfer the image archive for your Docker host and its `.sha256` file to the same
directory. Use `amd64` for x86-64 or `arm64` for 64-bit ARM hosts. For example,
on x86-64:

```sh
sha256sum -c aiomanager-2.1.0-linux-amd64.tar.gz.sha256
docker load -i aiomanager-2.1.0-linux-amd64.tar.gz
docker image inspect aiomanager:2.1.0 --format '{{.Os}}/{{.Architecture}} {{.Id}}'
```

Use `aiomanager:2.1.0` in the existing Portainer stack and leave **Re-pull image**
off for this local image. For Compose with the supplied template, set
`AIOMANAGER_IMAGE=aiomanager:2.1.0` and run
`docker compose up -d --no-deps --pull never aiomanager` after the backup steps
below. A published 2.1.0 multi-platform image can also be deployed by its verified
registry digest when available.

## Previous Stremio release

The published 2.0.0 image passed Windows/Linux, PostgreSQL and AMD64/ARM64 checks.
Its rollback image for installations previously on this version is:

```text
ghcr.io/hossman39/aiomanager@sha256:1dec7336720ce1b9d0a1f9bff5be0533d318f3dc7833b54d0e016d4897c37d9c
```

Its build commit is `67395d1`. [.env.example](.env.example) already contains this
digest for new installations. No integration/API key is required to launch or use
the app. The Box Manager connection is deferred.

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

- Health succeeds through the final HTTPS hostname. The footer shows `2.1.0` and
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
