# Project journal

Track dated implementation changes, decisions, verification, and remaining work.
Current setup and behavior are documented in [README](../README.md),
[DESIGN.md](DESIGN.md), and [IMPL.md](IMPL.md).

## 2026-10-20 — Prepare the uploader for additional JSON sources

The uploader initially assumed every upload contained Apple Health workouts.
Refactored the shared pipeline before initializing the remote D1 schema so future
non-workout sources can reuse storage and delivery without workout-specific
database columns.

### Changes and decisions

- Replaced shared `workout_count` with `record_count` and added `source`.
- Added a server-owned source adapter registry. Adapters define upload routes,
  validation, normalization, batch identity fields, record counts, and vault
  archive prefixes. Apple Health remains the only registered source.
- Moved Apple Health normalization into `src/sources/apple-health.ts` and shared
  canonical JSON serialization and hashing into `src/json.ts`.
- Persisted each batch's full `archive_path`; delivery uses that saved path so
  later routing changes cannot redirect queued uploads.
- Added the generic admin receipt route `GET /v1/batches/<batch-id>`. Preserved
  the existing Apple Health upload and receipt routes, request JSON, batch IDs,
  envelope bytes, and vault paths. Receipt consumers now use `source` and
  `record_count`, including for empty responses.
- Updated the initial D1 migration directly because the remote database had only
  been created. An already initialized database would require an explicit schema
  upgrade; editing the initial migration does not upgrade it automatically.
- Updated user, design, and implementation documentation.

### Verification

- TypeScript check and all 32 unit/SQL tests passed.
- A synthetic notes adapter exercised generic storage, receipts, source-scoped
  identities, and delivery without workout fields.
- Wrangler deployment dry run and local Worker/D1 integration passed, covering
  durable acceptance, outage recovery, retries, archival, duplicates, a 100-workout
  batch, and shared GitHub cooldown. All integration GitHub traffic was mocked.
- The example workout JSON passed the file validator; `git diff --check` passed.

### Remaining work

No deployment or remote D1 changes were performed. Apply the initial schema with
`npm run db:remote` before deploying. Future sources need their own adapter and
tests, plus a `digital-data-dump` importer if they should appear in reports.
Upload freshness is still global; add per-source freshness monitoring when
introducing independently scheduled sources.
