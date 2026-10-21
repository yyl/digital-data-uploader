# JSON source uploader design

This document describes the system boundaries and behavior. Exact APIs,
configuration, code paths, and test procedures belong in [IMPL.md](IMPL.md).
User setup and everyday usage belong in the [README](../README.md).

## Purpose and scope

Automate archiving source JSON into the private `digital-data-vault` repository.
Apple Health workout summaries from Actions + iPhone Shortcuts are the first
supported source. All validation and processing belong on the server; the
Shortcut sends the JSON it already produces.

The uploader is a standalone project. It accepts summaries and delivers archives;
the later `digital-data-dump` importer owns analysis and database reconciliation.
Summary uploads supplement the existing filtered XML archive, which contains
richer workout data and associated Health records.

Source adapters own their input validation, normalization, record count, identity
fields, upload route, and vault directory. Shared code owns authentication,
bounded JSON reading, batch construction, D1 acceptance, receipts, retries, and
GitHub delivery. The server registers supported adapters explicitly; clients
cannot supply arbitrary sources or archive paths.

The shared inbox stores `source`, `record_count`, and an immutable `archive_path`
alongside each envelope. Delivery uses that saved path, so a later adapter routing
change cannot redirect queued work. Adding a source does not require adding
source-specific D1 columns. It still needs an adapter, tests, and a separate
`digital-data-dump` importer if it should appear in reports.

Local phone ingestion and manual GitHub delivery have been verified. Cloud
deployment, automatic delivery on Cloudflare, and locked/unlocked scheduled phone
runs remain deployment validation tasks. The analysis importer is deferred.

## Components and ownership

| Component | Responsibility |
|---|---|
| iPhone Shortcut | Select a lookback window, construct workout JSON, authenticate, upload, surface failures. |
| Cloudflare Worker: ingestion | Authenticate, validate, preserve raw fields, normalize, identify a batch, save it durably, return a receipt. |
| Cloudflare D1 | Buffer immutable envelopes and retain receipt, retry, lease, capacity, and health state. |
| Same Worker: delivery | Pick pending work on a schedule or admin request, commit archives to GitHub, record outcomes. |
| `digital-data-uploader` | Own handler source, migrations, configuration, tests, and uploader documentation. |
| `digital-data-vault` | Own private workout archives and, independently, existing databases/source files. |
| `digital-data-dump` (future integration) | Read vault archives, reconcile workout identities, update analysis and reports. |

Personal workout payloads belong in the private vault and temporary delivery
buffer. Use synthetic fixtures in the uploader's source repository.

## End-to-end flow

```text
Time of Day automation / manual Shortcut run
  → Find workouts in rolling window → dictionaries → JSON text
  → authenticated upload to Worker
  → validation + raw/normalized envelope + deterministic batch identity
  → durable D1 inbox write → receipt returned to phone

Cloudflare schedule / authenticated admin retry
  → acquire delivery lease → select pending batches
  → verify private GitHub destination → create immutable batch file
  → record commit SHA and archived receipt in D1

Future, independently:
digital-data-dump → read vault JSON + XML → reconcile/import/analyze
  → database and report output in digital-data-vault
```

D1 separates acceptance from GitHub availability. The phone can finish once the
server has saved its data; delivery failures are handled by the Worker. A receipt
for accepted data, an archived file, and an imported workout are distinct outcomes.

There is no dependency on a `digital-data-dump` workflow to archive a batch. R2,
full-export ZIP ingestion, and synchronous delivery as the sole durability path
are outside this phase.

## Data interpretation and identity

Preserve the approved raw summary fields alongside a separate normalized view.
Missing measurements remain missing. Keep duration and elapsed time distinct;
energy meaning and assumed units need verification before use in analytics.
Do not infer XML-only samples, creation timestamps, or device metadata.

Input dates have minute precision and no timezone. Interpret them using the
configured Pacific timezone by default, applying PST/PDT by date. Record the
assumption and precision; retain raw dates and leave ambiguous/nonexistent DST
instants unresolved. Travel or a changed phone locale/timezone requires reviewing
the configuration; the server cannot recover omitted timezone or seconds.

Equivalent batch serialization must have the same identity regardless of object
key order or workout order. Identical uploads reuse their durable receipt.
Changed values or a different rolling window produce separate immutable
snapshots. Individual-workout deduplication across snapshots belongs to the
future importer. Empty uploads never imply deletions.

New adapters namespace batch identities by source. Apple Health keeps its original
identity algorithm and archive format for compatibility with local archives and
the downstream importer. Shared receipts expose `source` and `record_count`.

## Reliability and privacy

Persist acceptance before returning success. Keep the original envelope for
delivery retries, including its original receipt time. A lost response can be
recovered by submitting the same batch again.

Serialize consumers with a recoverable lease. Record archival only after GitHub
confirms the file; recover a crash between commit and acknowledgment by verifying
the existing bytes. Unexpected content must produce a visible failure. Preserve
pending data during outages and reject new work explicitly at capacity.

The GitHub credential stays on the server and is restricted to the private vault.
The phone has an upload credential; administrative actions use a separate one.
Use HTTPS for deployment, bounded inputs, authenticated limits, and sanitized
logs. Archive files are immutable and do not replace the existing XML/database.

Remove delivered payloads from the buffer after a retention period while keeping
compact receipts for idempotency. Monitor upload freshness and persistent
delivery failures. Proactive notifications require a separate monitor.

## Phone automation and recovery

Use a weekly or monthly Time of Day automation with Run Immediately, initially
preferring weekly for more recovery opportunities. A rolling 60-day export avoids
phone-side cursors and tolerates missed runs or delayed workouts. Reduce the
window if it exceeds the handler's limits; manually backfill longer gaps.

The Shortcut only selects workouts, builds JSON, uploads, and surfaces errors.
Scheduling does not override HealthKit lock restrictions. Test real scheduled
runs while locked and unlocked, and keep manual execution available. The handler
can recover delivery after acceptance, but cannot recover data the phone never sent.

## Future importer in digital-data-dump

Read immutable vault files without calling the Worker. Validate measurement
semantics against matched XML/Health samples before mapping to existing metrics.
Normalize activity names consistently, including the existing walk exclusion,
and preserve provenance and richer XML values when summaries omit them.

Actions UUIDs cannot be assumed equal to XML `HKExternalUUID` or fallback hashes.
Keep persistent aliases for canonical workouts. Match minute-precision candidates
using source/type, minute windows, and duration; only link unique verified matches.
Ambiguity must not silently inflate report counts. Missing seconds remain unknown.

Define deterministic source precedence and freshness rules so older replays do
not overwrite newer observations. Never infer deletions from rolling-window
absence. Rebuilding from JSON and XML must reproduce the same canonical workouts
without double counting. Keep processed-batch state and aliases with the database.

Back up before schema migration, test both import orders and report parity, and
follow that repository's checks. Its pipeline continues to own database/report
commits. Handle concurrent vault advances by regenerating changes on the newest
checkout and retrying; avoid choosing a binary SQLite conflict side or force-pushing.
