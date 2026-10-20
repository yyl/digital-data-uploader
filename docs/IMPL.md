# Uploader implementation

Implementation reference for the current code. See [DESIGN.md](DESIGN.md) for
system boundaries and [README.md](../README.md) for user instructions.
Run all commands below from the uploader project root.

## Runtime and source map

The Worker uses TypeScript with no runtime npm dependencies. Wrangler, Miniflare,
TypeScript, and type definitions are development dependencies pinned by the lockfile.
Use Node.js 22.18 or later; initial validation used Node 26.8.1. TypeScript was
chosen for direct Workers/D1 tooling integration; the processing does not require
a TypeScript-specific algorithm.

| File | Responsibility |
|---|---|
| [src/index.ts](../src/index.ts) | Configuration checks, authentication, bounded body reader, HTTP routing, sanitized responses, scheduled entry point. |
| [src/normalize.ts](../src/normalize.ts) | Field validation, quantity/flag/date parsing, timezone resolution, bounded date caches, canonical serialization, SHA-256. |
| [src/store.ts](../src/store.ts) | Atomic acceptance/capacity check, receipts, rate limits, lease operations, cleanup, upload health/status queries. |
| [src/deliver.ts](../src/deliver.ts) | Delivery loop, lease fencing, retry timing, shared GitHub cooldown, recording archival/failure. |
| [src/github.ts](../src/github.ts) | GitHub API client, private destination check, immutable create, existing-content verification, commit recovery, delivery errors. |
| [src/types.ts](../src/types.ts) | Environment/batch types, HTTP errors, limits, archive prefix, normalization version. |
| [migrations/0001_inbox.sql](../migrations/0001_inbox.sql) | D1 tables and delivery index. |
| [wrangler.jsonc](../wrangler.jsonc) | Entry point, runtime compatibility date, D1 binding, destination vars, cron, logging. |
| [scripts/wrangler.mjs](../scripts/wrangler.mjs) | Wrapper used by npm commands; runs installed Wrangler from project root and keeps config/logs under `.wrangler/` by default. |
| [scripts/validate-file.ts](../scripts/validate-file.ts) | Validate a supplied file without storing it or printing workout values. |
| [scripts/benchmark.ts](../scripts/benchmark.ts) | Local Node CPU reference for a synthetic 100-workout workload. |

## Configuration and credentials

For local use, copy [.env.example](../.env.example) to `.env` if needed, then fill
in its values. Wrangler loads `.env` natively. An existing `.dev.vars` takes
precedence and prevents `.env` loading; use one convention. Both secret-file
patterns and `.wrangler/` are ignored by Git; `.env.example` is tracked.

| Setting | Where / purpose |
|---|---|
| `UPLOAD_TOKEN` | Local `.env` / deployed Worker secret. Phone → ingestion. Random value at least 32 characters. |
| `ADMIN_TOKEN` | Local `.env` / deployed Worker secret. Operator → receipts, status, retry. At least 32 characters and different from `UPLOAD_TOKEN`. |
| `GITHUB_TOKEN` | Local `.env` / deployed Worker secret. Worker → GitHub. Fine-grained token restricted to the private vault, Contents read/write. |
| `GITHUB_OWNER` | `wrangler.jsonc` vars. Set the destination owner; `REPLACE_OWNER` is rejected. |
| `GITHUB_REPO` | `wrangler.jsonc` vars. Private destination, normally `digital-data-vault`. |
| `GITHUB_BRANCH` | `wrangler.jsonc` vars. Existing destination branch, normally `main`; the handler does not create it. |
| `ASSUMED_TIMEZONE` | `wrangler.jsonc` vars. Valid IANA zone; defaults to `America/Los_Angeles`. |
| `DB` | D1 binding in `wrangler.jsonc`, database name `digital-data-uploader`. Replace the placeholder database ID for deployment. |

Only the upload token belongs on the phone. Tokens are sent as
`Authorization: Bearer <token>`. Authentication hashes expected/provided headers
and compares all digest characters; headers over 1,024 characters are rejected.
Configuration validation precedes routing/authentication, so a configuration
problem can return 503 even for a request with an invalid credential. The GitHub
token must be nonempty to start serving; its validity/permissions are checked
through actual delivery requests.

Local D1 is separate from remote D1. Local delivery uses real outbound GitHub
requests when valid credentials are supplied: use a private staging vault for
tests whose files you do not want in the main vault. The integration test below
mocks all GitHub requests.

## HTTP API

Deploy with HTTPS. Local development uses `http://localhost:8787` or the Mac's
LAN address. All handler responses are JSON with `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. Query strings are rejected. There is no browser
upload UI or CORS configuration; the client is Shortcuts or an HTTP tool.

| Method and route | Credential | Result |
|---|---|---|
| `POST /v1/workout-batches` | Upload | Validate and save `{"workouts":[...]}`. JSON content type required. |
| `GET /v1/workout-batches/<batch-id>` | Admin | Receipt metadata; ID must be 64 lowercase hexadecimal characters. Unknown valid ID returns 404. |
| `GET /v1/status` | Admin | Inbox counts, retained bytes, upload/archive timestamps, cooldown, health flags. |
| `POST /v1/admin/retry` | Admin | Requeue all failed/retrying batches, then attempt up to three due batches. No request body required. |

Other routes/methods return 404. Upload tokens cannot read receipts/status or retry.
The authenticated fixed-minute limits are 30 requests for upload and 60 for admin,
shared by role. Rejected authenticated requests also consume this allowance.
429 responses include `Retry-After: 60`. Unauthenticated abuse requires separate
edge controls if needed.

### Request validation and responses

The upload reader accepts uncompressed UTF-8 JSON (`Content-Encoding` absent or
`identity`). It checks both declared length and actual streamed bytes, caps the
body at 256 KiB, and cancels a read after ten seconds. Maximum batch size is 100
workouts. A bad workout rejects the entire batch before acceptance.

New batches normally return HTTP 202 and a receipt shaped like:

```json
{
  "batch_id": "<64-character hash>",
  "status": "queued",
  "workout_count": 10,
  "received_at": "2026-10-20T12:54:05.453Z",
  "archived_at": null,
  "commit_sha": null,
  "error": null
}
```

Duplicate uploads reuse the original receipt, with HTTP 200 if archived and 202
otherwise (including `retrying` or `failed`). An empty list returns HTTP 200 with
`{"status":"empty","workout_count":0}` and creates no batch. Successful empty
and duplicate uploads refresh upload health. `202` alone does not guarantee the
receipt is currently queued; inspect its `status` and `error`.

Receipt GET returns the same metadata. An archived receipt includes `archived_at`
and the actual GitHub commit SHA. No read endpoint returns workout payloads.

| HTTP status | Error category / representative code |
|---|---|
| 400 | Malformed JSON/read failure (`invalid_json`, `body_read_failed`), query string (`query_not_supported`). |
| 401 | Missing/wrong role credential (`unauthorized`). |
| 404 | Unknown route or receipt (`route_not_found`, `batch_not_found`). |
| 408 | Body timeout (`body_read_timeout`). |
| 413 | Byte/count cap (`body_too_large`, `too_many_workouts`). |
| 415 | Media type/encoding (`expected_application_json`, `unsupported_content_encoding`). |
| 422 | Schema/value problem (`invalid_field`, `duplicate_identifier`), with `field` path. |
| 429 | Authenticated role rate limit (`rate_limited`). |
| 503 | Configuration (`service_not_configured`), capacity (`inbox_capacity_reached`), or sanitized unexpected failure (`internal_error`). |

Errors have `{"error":"<code>"}` and, when applicable, `"field"`. No exception
details, SQL bindings, payloads, or credentials are returned or logged. If a
request fails after its batch write, an identical reupload recovers the stored
receipt; an HTTP failure need not imply no database write occurred.

### Retry and status output

Normal retry output is `{"busy":false,"archived":2,"failed":0}`. `busy: true`
means another invocation holds the lease. A shared cooldown returns zero counts
plus `retry_after` as an ISO timestamp. HTTP 200 means the retry operation ran;
inspect its counts and individual receipts for delivery success.

Retry processes the inbox, not just the phone's most recent upload. One call may
produce up to three commits for different batches, including earlier synthetic
tests. Each new file uses the current message `Archive Apple Health workout batch`.
Recovery of an already existing matching file creates no new commit.

Status returns `receipts`, `pending` (queued + retrying), `failed`, `payload_bytes`,
`oldest_unarchived`, `last_accepted`, `last_archived`, `last_upload`, and
`delivery_not_before` (epoch milliseconds or null). Receipt/archive/upload times
are ISO strings or null. `last_accepted` tracks new batches; `last_upload` also
tracks successful empty/duplicate requests.

- `health.delivery_attention_required`: any failed batch, or unarchived data older than one day.
- `health.upload_stale`: no successful upload yet, or the last one is over 14 days old. This threshold suits weekly uploads; monthly schedules will cross it.

## Input and normalized archive

The root must contain only `workouts`, an array. All supplied workout values must
be strings, at most 1,024 characters with no ASCII control characters. Required
nonempty fields are `identifier`, `type`, `start_date`, `end_date`, and `duration`.
Unknown fields are rejected. See the [synthetic example](../examples/workouts.json).

| Input fields | Accepted form / normalization |
|---|---|
| `identifier` | UUID; normalized lowercase. Case-insensitive duplicates within a batch are rejected. |
| `type`, `source_name`, `device_name`, `device_model`, `recording_method` | Strings retained in raw fields; type is also retained in normalized output. |
| `start_date`, `end_date` | English `Oct 15, 2026 at 08:31`; years 1900–2200, valid calendar date, 24-hour hour/minute. |
| `duration`, `elapsed_time` | Strict nonnegative decimal followed by ` sec`, at most 604,800 seconds each; separate normalized seconds. |
| `energy_burned` | Number followed by ` kcal`, at most 100,000; normalized interpretation remains `unverified`. |
| `active_calories` | Unitless number at most 100,000; normalized assumed unit `kcal`. |
| `average_heart_rate` | Unitless number at most 300; normalized assumed unit `bpm`. |
| `flights_climbed` | Unitless whole number at most 100,000. |
| `total_distance` | Number with `m`, `km`, `mi`, `ft`, or `yd`; retained value/unit, at most 1e9. |
| `average_speed` | Number with `m/s`, `km/h`, `km/hr`, `mi/hr`, `mph`, or `kph`; retained value/unit, at most 1e9. |
| `is_from_watch`, `is_from_third_party` | `Yes`/`No` → boolean. |

Numbers must be finite; correctly grouped commas and decimal fractions are
accepted. Signs, exponent notation, malformed grouping, and unsupported units
are rejected. Optional fields may be absent/empty; missing normalized measurements
become null. Distance/speed retain their units rather than converting to one base unit.

Date parsing uses `Intl.DateTimeFormat` with the configured zone, samples offsets
around the date, and round-trips candidate instants. Exactly one match yields
`utc` and `resolution: assumed_timezone`; multiple/zero matches yield null UTC
with `ambiguous`/`nonexistent`. Every normalized timestamp includes
`timezone_assumed` and `timestamp_precision: minute`. End-before-start is rejected
when both instants resolve. Formatter and offset caches are bounded.

### Batch identity and envelope

Sort object keys recursively and workouts by normalized UUID. The batch ID is
SHA-256 of canonical `{schema_version, normalization_version, timezone_assumed,
workouts: <sorted raw workouts>}`. Schema and normalization versions are currently
1. Raw values, including UUID spelling, are preserved in this hash input; changing
a value, adding an optional field, or using a different timezone can change the ID.
Key order and workout order do not change it.

The persisted canonical envelope contains `batch_id`, original `received_at`,
schema/normalization versions, `timezone_assumed`, `warnings`, and
`workouts: [{raw, normalized}]`. Its separate SHA-256 `archive_hash` verifies exact
file bytes; it differs from the batch ID because it includes receipt metadata and
normalized output. Delivery always reuses the persisted envelope.

Warnings record timezone/minute assumptions, unverified duration/elapsed meanings,
and unverified energy semantics/assumed measurement units. They are provenance,
not a validation failure. XML parity is required before analytics mapping.

Archive path: `files/apple_health/actions/batches/<batch-id>.json`. Distinct
snapshots can contain the same workout UUID; this service does not merge workouts
across batches or deduplicate them against the existing analysis database.

## D1 and delivery internals

| Table | Stored state |
|---|---|
| `batches` | ID/hash, immutable envelope, bytes/count, receipt times, queued/retrying/failed/archived state, attempts, next attempt, error, commit SHA. |
| `delivery_lease` | Singleton owner token and expiry; 120-second lease renewed before each batch. |
| `rate_windows` | Per-role fixed-minute request counter. |
| `upload_health` | Singleton last successful upload time, including empty/duplicate uploads. |
| `delivery_backoff` | Singleton destination-wide GitHub cooldown. |

`batches_due` indexes state, next attempt, and received time. Retry/cooldown/lease
times use epoch milliseconds; receipt timestamps use ISO strings.

Acceptance uses a single `INSERT … SELECT` capacity check with conflict handling,
then reads the durable row. Limits are 32 MiB of retained envelope bytes and 50,000
total receipts. The byte cap includes delivered envelopes awaiting cleanup.
Capacity exhaustion rejects new batches without evicting pending work; retained
duplicates can still return their receipt. Platform quotas remain separate.

Delivery acquires the singleton lease, cleans old archived payloads, checks the
shared cooldown, then handles up to three due queued/retrying batches, oldest
first. A competing consumer returns busy. Database acknowledgments and failure
updates are fenced by owner token and unexpired lease; stale owners cannot
acknowledge a newer owner's work.

For each batch, the GitHub adapter:

1. Fetches repository metadata and requires `private: true` before sending content.
2. Fetches the immutable archive path on the configured branch.
3. If present, decodes base64 and checks exact envelope hash; on a match it fetches
   path history to obtain the actual commit SHA (the Contents API SHA is a blob SHA).
4. If absent, calls the Contents API to create the file, without an update SHA.
5. Returns the confirmed commit SHA; only then does D1 mark the batch archived.

Requests go to `api.github.com`, have an eight-second timeout, and use manual
redirect handling; redirects become permanent errors. A crash after file creation
but before acknowledgment recovers through step 3 without overwriting the file.

Network/invalid-response/server failures and 409/422 create conflicts are retryable.
Backoff starts at one minute and doubles to one hour. Rate-limit responses use
Retry-After/reset headers, bounded to one minute–one day, and persist a shared
cooldown so other batches and manual retry also wait. Access failures (401/403/404
outside the missing-file probe), rejected requests, redirects, public destinations,
missing payloads, and unexpected existing content become failed receipts.

`attempts` counts acknowledged successes or recorded failures. After a failure the
loop normally stops; `archive_content_conflict` allows it to continue to another
batch. Admin retry resets failed/retrying rows to queued with immediate eligibility,
while preserving attempts and the shared rate-limit cooldown.

Pending/failed payloads are retained. Cleanup, performed during delivery, removes
archived envelopes older than seven days and zeroes their byte counts. Compact
receipts/hashes are kept indefinitely. **Do not manually delete receipts**: their
original envelope hash/time is needed to recover idempotently against old files.
Normalization changes require a version bump and must preserve delivery of already
queued envelopes.

## Local development and testing

### Automated checks

```sh
npm ci
npm run check
npm test
npm run test:integration
npm run validate-file -- /path/to/workouts.txt
npm run benchmark
```

`npm run build` is a Wrangler deployment dry run, writing `.wrangler/build`; it
does not deploy. Integration builds first, then uses real workerd/local D1 with
synthetic credentials and all GitHub responses mocked. It needs a loopback port,
does not use your `.env` credentials for requests, and does not write the vault.
Unit tests exercise production SQL using in-memory SQLite.

Look for durable acceptance, stable duplicate receipts, all-or-nothing validation,
auth separation, capacity/body limits, correct DST handling, immutable creates,
crash recovery, lease fencing, outages, and shared cooldown. Integration covers
upload → outage → retry → archive, duplicate recovery, and a 100-workout batch.
Historical checks/results are in [REVIEW.md](REVIEW.md).

The file validator prints field names/counts, warnings, and unresolved-date count,
without workout values or persistence. It calls normalization directly; it does
not enforce the HTTP byte reader/auth/storage/delivery behavior. It reads timezone
from the process environment, defaulting to Pacific; this script does not load
`.env` or `wrangler.jsonc` automatically.

The benchmark reports local Node CPU, not Cloudflare billed CPU. Initial maximum
synthetic workload was about 230 KiB and measured about 20.6 ms cold / 2.7 ms warm
median on Node. These historical numbers do not establish Workers Free compatibility.
Measure cold/warm requests on staging against the chosen plan's current allowances;
reduce workload or choose an appropriate plan if needed. No paid plan is enabled
by the project.

### Exercise the handler from the Mac

With `.env` and destination vars configured:

```sh
npm run db:local
npm run dev -- --ip 0.0.0.0
```

In another terminal at the project root, load the trusted local `.env` into the
shell (the provided template uses shell-compatible assignments):

```sh
set -a
source .env
set +a
export UPLOADER_URL='http://localhost:8787'
```

Read status or deliver the existing inbox:

```sh
curl --fail-with-body -sS "$UPLOADER_URL/v1/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl --fail-with-body -sS -X POST "$UPLOADER_URL/v1/admin/retry" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

To test ingestion using a file:

```sh
curl --fail-with-body -sS "$UPLOADER_URL/v1/workout-batches" \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/workouts.json
```

This sample creates a real queued synthetic batch in your local inbox. A later
admin retry can commit it to the configured vault along with phone uploads; use
the mocked integration test for disposable end-to-end fixtures. Local cron is not
an automatic five-minute timer; use admin retry to drive delivery in this workflow.

Use the returned batch ID to check its receipt:

```sh
curl --fail-with-body -sS "$UPLOADER_URL/v1/workout-batches/<batch-id>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Look for queued → archived, a commit SHA, and the expected file in the configured
private repository/branch. Resend an identical file: expect the same batch ID and
original `received_at`, HTTP 200 after archival, and no new commit.

### Test via an iPhone

Use the [README Shortcut settings](../README.md#connect-your-iphone). Start the
server with `--ip 0.0.0.0`, put the Mac's actual LAN IP in the phone URL, keep both
devices on the same network, and allow local network/firewall access if prompted.
Use HTTP locally, POST, upload bearer token, JSON content type, and **File** body
pointing to the final JSON Text. Add Show Result while testing.

Verify the phone receives a receipt, run admin retry from the Mac, then inspect
the receipt, archive path, raw/normalized values, warnings, and workout count.
Repeating unchanged JSON should reuse the receipt. A moving date window or changed
source values can legitimately produce another batch.

Local phone acceptance and real vault delivery were verified on 2026-10-20.
One retry archived an earlier synthetic batch and a ten-workout phone batch as
two separate commits. This verifies local manual delivery; deployed cron and
scheduled locked/unlocked phone execution remain to be tested.

## Cloudflare deployment

1. Authenticate with `npm run cf -- login`, or provide `CLOUDFLARE_API_TOKEN` for
   Wrangler. This deployment credential is separate from the three application tokens.
2. Run `npm run cf -- d1 create digital-data-uploader`. Copy its ID into the `DB`
   binding in `wrangler.jsonc`; verify owner/repo/existing branch/timezone vars.
3. Set the three application secrets through interactive prompts:

   ```sh
   npm run cf -- secret put UPLOAD_TOKEN
   npm run cf -- secret put ADMIN_TOKEN
   npm run cf -- secret put GITHUB_TOKEN
   ```

4. Run `npm run db:remote`, then `npm run cf -- deploy`.
5. Switch the phone to `https://<YOUR-WORKER>/v1/workout-batches`, with the matching
   deployed upload token. Send an upload, verify automatic archival, inspect the
   private file/receipt, and measure staging CPU before enabling the phone schedule.

The configured cron is `*/5 * * * *` (UTC). Invocation logs are disabled;
application logs contain fixed codes such as `request_failed`, `delivery_failed`,
`delivery_attention_required`, and `upload_stale`. An unexpected scheduled error
is sanitized as `scheduled_delivery_failed`. Do not enable body/header tracing
or publish local `.wrangler/` state. Proactive alerts need an external authenticated
monitor or account notification setup; this code does not send notifications.

## Troubleshooting

| Symptom | Check / action |
|---|---|
| Phone cannot connect | Server running, same LAN, Mac IP/port, local network permission, firewall. |
| 401 | Exact `Bearer ` prefix and correct role token; local/deployed values may differ. |
| 503 `service_not_configured` | Both distinct 32+ character auth secrets, nonempty GitHub secret, destination vars, DB binding, valid timezone. |
| 400/415/422 | Final JSON object rather than double-encoded text; File body, JSON content type, documented fields/date/units; inspect `field`. |
| 413 | Reduce the exported date window/workout count or JSON byte size. |
| Accepted but no file | Receipt state; run retry locally, or inspect deployed cron/status. Acceptance and delivery are separate. |
| Multiple commits from one retry | Several pending batches; compare batch IDs, received times, and counts. |
| `github_access_denied` | Token scope/expiry, repo access, owner/repo, existing branch; fix, then admin retry. |
| `destination_not_private` | Correct destination to a private repository. |
| `github_rate_limited` / `retry_after` | Wait for shared cooldown; admin retry deliberately preserves it. |
| `archive_content_conflict` | Inspect retained D1 envelope and vault bytes before manual reconciliation. |
| `inbox_capacity_reached` | Resolve delivery backlog; successful old envelopes are cleaned during delivery. Do not delete pending data or receipts. |
| Stale health with monthly uploads | The current upload threshold is 14 days; interpret monitoring against the intended schedule. |

Rotate Worker secrets and update the phone when its upload token changes. Keep
GitHub credentials server-side. An archived summary is not confirmation that a
workout has been imported into the analysis database.
