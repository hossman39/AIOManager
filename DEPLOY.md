# Deploy the managed AIOManager fork

Release images belong to `ghcr.io/hossman39/aiomanager`. Use the image digest or
`sha-<full-commit>` from the tested release. Never substitute the original upstream
image for this fork or use an unattended `latest` update.

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
4. Set `MANAGED_WRITES_ENABLED=true` and `MANAGED_BACKUPS_ENABLED=true`. Run one
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

For the supplied root Compose layout, copy `.env.example` to `.env`, set
`AIOMANAGER_IMAGE` to the release image, and retain the correct `DB_TYPE` and mounts.
It still includes the original PostgreSQL service. Existing Portainer installations
should update their own stack definition rather than blindly replace its volume
layout. `compose.managed-test.yml` is an isolated test stack, not a production upgrade.

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

## API connection

After deployment, create a key in **Settings → API integrations**. Test
`GET /api/v1/me` using its Bearer header. The first release controls Stremio
accounts/groups/memberships and sync. TV Box Manager's interface and IPTV-provider
adapter remain separate integration work. See [API.md](docs/API.md).
