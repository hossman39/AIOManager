# V2: viewing metrics and personal recommendations

Status: discovery roadmap only. V1 migration, groups, and expiry take precedence. Keep V2 processing independently disableable so an analytics failure cannot delay expiry or addon management.

## 1. What "all Slicksync metrics" requires

Slicksync is a moving reference with multiple provider integrations. Record the desired feature inventory against the inspected commit `33023f4cd887c12daa56788da7ad0ef2da83d581`, then agree parity by feature and available data. Do not assume copying a dashboard imports its collection pipeline or historical data.

The following is an initial inventory from its source/README and AIOManager's existing metrics; it must become an agreed checklist before V2 implementation:

| Capability | Potential input | Main uncertainty / validation |
| --- | --- | --- |
| Current activity / Now Playing | Provider progress deltas; optional AIOStreams proxy sessions | Polling delay and proxy coverage; show freshness rather than asserting live presence |
| Watch history, completion, rewatches | Provider library snapshots and supported watch events | A snapshot is not a complete event history; rewatches and seeking can be ambiguous |
| Watch-time trends, leaderboards, streaks | Validated activity deltas and account timezone | Observed versus inferred duration; missing polls, reset positions, DST |
| Per-user/group statistics | Stable client IDs and time-stamped group assignment history | Define whether historical activity belongs to the group at the time or the current group |
| Top titles / trending | Deduplicated title and episode events | Correct cross-provider IDs and distinct viewers |
| Viewing heatmaps / retention / abandoned titles | Dated events and configurable inactivity definitions | Missing data must not become proof of non-viewing or churn |
| Taste profiles / year in review | Per-user history and supported title metadata | Cold start, sparse history, metadata gaps, and privacy |
| Operational health | V1 job, expiry, verification, and provider-health observations | Already useful in V1; avoid inventing viewing telemetry from addon management |

Reference modules: `server/utils/metricsBuilder.js`, `metricsProcessor.js`, `activityMonitor.js`, `recommendationEngine.js`, and the reference's history models. Its recommendation code explicitly describes incomplete duration coverage; those caveats belong in our requirements and UI.

## 2. Data model and collection

Add provider adapters that produce versioned observations: manager/client ID, provider subject, canonical title/episode IDs, observed time, provider event time if available, source, progress/duration, and confidence. Derive normalized playback events and aggregates with explicit deduplication rules. Do not infer actual viewing solely from fetching a catalog, metadata, or stream URL.

Store raw observations for a bounded retention period and rebuild aggregates deterministically. Track collection watermarks, deletion markers, clock differences, gaps, and schema version. Avoid writing to a provider's watch state while collecting statistics.

The owner confirmed no history migration in V1. V2 begins with supported provider history and newly observed activity, with historical limits explicit. Any later Slicksync history import needs a separate read-only adapter for its actual schema, identity remapping, provenance, and deduplication. Do not copy its operational database/jobs or assume missing history can be reconstructed.

Privacy decisions precede collection: which clients participate, retention, administrator visibility, per-user deletion/export, and whether household statistics may use another client's viewing. V2 defaults to private per-account data; no public statistics or cross-client recommendations are automatically enabled.

## 3. Personal recommendation catalogs

The user-facing result should be a private movie/series lineup inside each client's Stremio app. A proposed implementation is a managed catalog addon with a distinct opaque, revocable token per client. The official [addon protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html) supports catalog resources, and [advanced usage](https://stremio.github.io/stremio-addon-sdk/advanced.html) describes user-specific configuration in addon URLs.

Each request resolves the token to one client, checks entitlement, and serves that client's precomputed lists. Tokens must be separate from Stremio authentication keys, stored safely, redacted from logs, and included correctly in cache partitioning. One client's token must never retrieve another client's history or list. Expiry blocks serving the personalized catalog as well as scheduling its removal; clients may retain previously cached responses.

Start with explainable content-based ranking: genres/creators from validated viewing, exclude already-watched titles where reliable, permit Not Interested feedback, and offer a clearly labeled starter lineup for insufficient history. Age/language/preferences and any content filters need explicit requirements. A unique per-user computation does not imply every user will receive entirely different titles.

Support manually curated per-user lists alongside automatic rows. Treat "playlist" as a recommendation catalog unless the owner specifically wants automatic sequential playback; that is a separate client capability.

Do not require an LLM or paid recommendation service for the first version. Metadata/provider selection, licensing, quotas, and cost are evaluated when implementation starts. Collaborative filtering using other clients' histories is optional and requires a separate privacy/product choice; it is not needed to meet individual viewing-based recommendations.

## 4. Group integration

V1's individual-addon layer provides a seam for a later personal catalog with a different tokenized URL per client. V1 group manifest URLs remain identical across members; do not build a template/binding engine prematurely. V2 must never stamp one person's catalog URL onto the group. Renewal/token rotation use the same versioned queue and entitlement checks.

Generate recommendations in background work with separate concurrency/resource budgets. Catalog requests read cached results and do not run expensive recommendation or watch-history queries on every request. Index by client and canonical content ID. Cache failures cannot expose a different client's fallback response.

## 5. Delivery phases

| Phase | Deliverable | Acceptance evidence |
| --- | --- | --- |
| V2-A: inventory | Agreed parity matrix, data sources, privacy/retention, metadata budget | Each requested metric has a source and honest quality definition |
| V2-B: history | Incremental ingestion, identity mapping, read-only import, deletion/export | Deduplication, gaps, seeking/rewatch cases, and cross-client isolation tests |
| V2-C: dashboards | Validated metrics built from the same normalized history | Fixture totals reconcile; estimates visibly labeled; UI remains responsive |
| V2-D: personal catalogs | Per-user token, manual/automatic lists, entitlement checks | Two clients demonstrably receive their own lists; token rotation/revocation and expired access tested |
| V2-E: optimization | Background ranking, cache tuning, optional richer recommendations | Load/soak shows no regression in V1 group/expiry latency or memory budgets |

## 6. What V1 should prepare now

Keep stable destination identities, explicit individual addons, time-stamped group changes, versioned data/migrations, isolated provider adapters, job priorities/request budgets, and reusable expiry checks. Do not add history import to the agreed email/password-only V1 migration.

Do not add the V2 collectors, recommendation dependencies, metadata subscriptions, catalog endpoints, or expanded dashboards to V1 merely to prepare for them. These architectural seams and data-preservation requirements are sufficient until the core release is stable.
