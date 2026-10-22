# Project journal

Track dated implementation changes, decisions, verification, and remaining work.
Current setup and behavior are documented in [README](../README.md),
[DESIGN.md](DESIGN.md), and [IMPL.md](IMPL.md).

## 2026-10-21 — Verify Strong upload from an iPhone

The user tested `POST /v1/strong-export` from an iPhone against the local Worker
and confirmed HTTP 200 after setting the upload's Content-Type to `text/csv`.
Kept the exact Content-Type check and removed flexible MIME handling.

The local Worker uses the configured GitHub credentials to save the CSV in DDV
on GitHub; it does not update the local DDV checkout. Changed exports replace
`files/strong_workouts.csv`, identical files produce no commit, and D1 is used
only for the shared upload rate limit on this route.

Verification: TypeScript check, all 45 unit/SQL tests, Wrangler deployment dry
run, local workerd/D1 integration with mocked GitHub traffic, and DDD's
`make test-ci` (285 tests). Cloud deployment was not performed.

## 2026-10-21 — Require text/csv for Strong uploads

Strong uploads require `Content-Type` exactly `text/csv`, per the user's
preference. Removed MIME fallback, case normalization and parameter parsing.
Missing or different values return 415 `expected_csv`. CSV structure validation
and byte preservation are unchanged. Updated regression tests and instructions.

## 2026-10-21 — Direct Strong CSV uploads

- Added `POST /v1/strong-export`, authenticated with the existing upload token.
  It validates full-export CSV structure and writes unchanged UTF-8 bytes directly
  to `files/strong_workouts.csv`. The fixed path matches DDD's existing importer.
- Changed files replace the existing GitHub file using its observed blob SHA.
  Identical uploads return `unchanged` without a commit. Conflicts and delivery
  failures are visible to the caller; retrying after a lost response is safe when
  the same bytes are still present.
- Kept D1 only for shared rate limiting on this route. No Strong inbox payload,
  batch receipt, upload-health update, schema migration or automatic retry was
  introduced. Apple Health keeps its immutable queued archive flow.
- Extracted the bounded byte reader for JSON and CSV; CSV has a 512 KiB cap and
  JSON retains its 256 KiB cap. CSV checks preserve BOM, Unicode, quoted notes,
  multiline fields and line endings without interpreting workouts.
- Documented the Strong file/share-sheet Shortcut and HTTP responses.

Verification: TypeScript check, all 44 unit/SQL tests, Wrangler build dry run and
local workerd/D1 integration passed. GitHub traffic was mocked. The existing
133,795-byte vault export also passed validation with exact byte preservation;
it was read only. A real Strong phone upload and deployment remain to be checked.

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
