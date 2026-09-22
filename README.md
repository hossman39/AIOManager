# AIOManager — managed accounts

This is [hossman39's fork](https://github.com/hossman39/AIOManager) of AIOManager.
Version 2.0.0 adds individual and group addon management, per-account membership
expiry and renewal, and bulk operations.

- Manage individual accounts or publish a shared group configuration.
- Preserve personal overrides, protected addons and saved preferences through expiry.
- Choose which addons disable on expiry; optionally show a renewal notice in Stremio.
- Review first sync, track verified results, and remove accounts after verified cleanup.
- Find accounts expiring in 7/30 days or needing attention; sort by expiry.
- Optional integration keys can be configured later from Settings.
- Retain daily encrypted application backups with a separate restore tool.

## Installation and updates

Use the fork's [deployment guide](DEPLOY.md) and the published
[2.0.0 release](https://github.com/hossman39/AIOManager/releases/tag/v2.0.0).
The environment example pins its tested image digest. The default Compose file
runs the app with SQLite or an existing external database; add
[compose.postgres.yml](compose.postgres.yml) only for the bundled PostgreSQL service.
Keep the actual database engine, mounts and keys when updating an existing stack.
The separate [test stack](compose.managed-test.yml) uses its own data volume.

Serve the app through HTTPS. Enable `MANAGED_WRITES_ENABLED=true` in the intended
instance, then resume from **Settings → Account sync**. New accounts stay inactive
until first-sync review and activation. Only one instance may write per database.
API access and the Box Manager integration are optional and are deferred for launch.

## Documentation

- [Deployment and live acceptance](DEPLOY.md)
- [Testing walkthrough](docs/TESTING-MANAGED.md)
- [Implementation evidence](docs/planning/PROGRESS.md)
- [Release verification](docs/planning/VERIFICATION.md)
- [Optional integration API](docs/API.md)

Android TV notice/refresh behavior is checked on the live deployment. Whole-server
backup infrastructure is separate from the app's encrypted daily archives.

## Development

Node 24 is used in CI. Install with `npm ci --ignore-scripts`, then
`npm rebuild better-sqlite3 --ignore-scripts=false`. Run `npm run typecheck`,
`npm run lint`, `npm test`, and `npm run build`. Tests use synthetic accounts.
`npm run managed:demo` starts an isolated browser rehearsal with fake provider traffic.

## Credits

The upstream AIOManager and Stremio Account Manager authors retain their attribution.
The MIT license applies; see [LICENSE](LICENSE).

<div align="center">
  <h3>🤝 Credits & Acknowledgements</h3>
  
  AIOManager is a fork and major evolution of the original <b>Stremio Account Manager</b> by <b>Asymons</b>.  
  Without the foundational work of the following projects and individuals, this would not exist:

  <b>[pancake3000](https://github.com/pancake3000/stremio-addon-manager)</b> (The Original Creator)  
  <b>[Asymons](https://github.com/Asymons/stremio-account-manager)</b> | <b>[Stremio](https://stremio.com)</b> | <b>[Syncio](https://github.com/iamneur0/syncio)</b> | <b>[CineBye](https://cinebye.dinsden.top/)</b>  

  <br />

  Special thanks to the community inspirations who made this journey possible:  
  <b>redd-raven</b>, <b>Viren070</b>, <b>0xConstant1</b>, <b>Sleeyax</b> & <b>&lt;Code/&gt;</b>.

  <br />

  *Built with ❤️ for the Stremio Community.*
</div>
