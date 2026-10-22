# digital-data-uploader

Upload Apple Health JSON summaries or a full Strong CSV export to your private
`digital-data-vault` GitHub repository. Apple Health uses a durable inbox and
immutable archives. Strong saves the original CSV directly to one replaceable file.

Apple Health phone uploads and manual delivery to the vault have been tested
locally. A Strong phone upload to the local server returned HTTP 200, and mocked
Worker integration tests cover its GitHub delivery. Cloud deployment and scheduled
phone runs still need verification.

## Set up and run

Use Node.js 22.18 or later. Install dependencies, then create your local settings
if you have not already done so:

```sh
npm ci
cp .env.example .env
```

Keep an existing `.env` when repeating setup. Configure credentials and the private
destination using [implementation setup](docs/IMPL.md#configuration-and-credentials).
Then start the local server:

```sh
npm run db:local
npm run dev -- --ip 0.0.0.0
```

Keep the terminal open while testing. For an internet-accessible endpoint, follow
the [Cloudflare deployment steps](docs/IMPL.md#cloudflare-deployment).

## Upload a Strong export

Export your complete workout history from Strong and send the CSV file to
`POST /v1/strong-export`. The server checks its CSV structure and required headers,
then saves the original bytes to `files/strong_workouts.csv` in the configured
private vault branch. Each changed export replaces that file; Git history retains
previous versions. There is no workout normalization or analysis in this route.

Create a Shortcut that receives **Files** from the share sheet (or selects the
export with **Select File**), followed by **Get Contents of URL**:

| Setting | Value |
|---|---|
| URL | `https://<YOUR-WORKER>/v1/strong-export` (local: `http://<MAC_NETWORK_IP>:8787/v1/strong-export`) |
| Method | `POST` |
| Header `Authorization` | `Bearer YOUR_UPLOAD_TOKEN` |
| Header `Content-Type` | `text/csv` |
| Request Body | **File**, selecting the exported CSV / Shortcut Input |

Enable **Show in Share Sheet** for the Shortcut and share the exported CSV from
Strong or Files. Send one file directly, without converting it into JSON or a
multipart form. Add **Show Result** after the request.

The server requires `Content-Type: text/csv` and validates the CSV contents.
A missing or different type returns 415 `expected_csv`. Set that header explicitly
in the Shortcut and use Request Body **File**. JSON-wrapped files are invalid CSV.

HTTP 200 with `status: saved` means GitHub confirmed the commit; the response
includes `commit_sha`. `status: unchanged` means the same bytes are already saved
and no commit was made. The file limit is 512 KiB. Empty/header-only exports,
malformed CSV and missing required headers are rejected before saving.

Strong uses D1 only for the shared upload rate limit. It has no pending batch,
receipt lookup, scheduled delivery or automatic retry. On an HTTP error, keep the
export and resend it; respect `Retry-After` when present. A conflict (409) means
the destination changed during the upload: check the latest export before retrying.
Always select the latest full export, since a successful upload replaces the
current file. Strong uploads do not refresh Apple Health's upload-health timestamp.

`digital-data-dump` already reads this filename through `strong-sync` and
`strong-analyze`; uploading does not run those commands. Its published workout
metrics continue to use Apple Health.

## Connect your iPhone

These settings are for Apple Health; Strong uses the CSV upload instructions above.

Keep the working **Find Workout → Repeat → dictionaries → JSON text** sequence,
producing `{"workouts":[...]}`. Start with a rolling 60-day window; use smaller
windows if you exceed 100 workouts or 256 KiB per upload.

Add **Get Contents of URL** after your final JSON text:

| Setting | Value |
|---|---|
| URL, local testing | `http://<MAC_NETWORK_IP>:8787/v1/workout-batches` |
| URL, deployed | `https://<YOUR-WORKER>/v1/workout-batches` |
| Method | `POST` |
| Header `Authorization` | `Bearer YOUR_UPLOAD_TOKEN` |
| Header `Content-Type` | `application/json` |
| Request Body | **File**, selecting your final JSON **Text** variable |

For local testing, use the Mac's IP from **System Settings → Wi-Fi → Details →
TCP/IP**, with both devices on the same network. Allow local network/firewall
access if prompted. The phone uses that IP, such as `192.168.1.50`; `0.0.0.0`
is the server's listening address.

Add **Show Result** after the request while testing. Send the serialized text
directly using **File** so it does not become an escaped JSON string inside
another object.

## Check the result

| Response | Meaning / next step |
|---|---|
| `queued` | Saved in the inbox; delivery to GitHub is pending. |
| `retrying` | Saved; delivery will be attempted again after a temporary failure. |
| `archived` | Saved in the private vault; the receipt includes its commit SHA. |
| `empty` | Successful request with no workouts to save. |
| `failed` or an HTTP error | Inspect the error and fix the cause; see [troubleshooting](docs/IMPL.md#troubleshooting). |

On Cloudflare, delivery runs hourly. Locally, use the
[admin retry command](docs/IMPL.md#exercise-the-handler-from-the-mac) after uploading.
One retry can deliver up to three pending batches, with one commit per newly
archived batch—including uploads left from earlier tests.

Open the configured branch of your private vault repository on GitHub and look in:

```text
files/apple_health/actions/batches/<batch-id>.json
```

Each file contains the original workout summary fields plus processed values and
interpretation warnings. Repeating an identical upload reuses its receipt. These
archives do not yet update the analysis database or reports in `digital-data-dump`.
Keep the existing XML export workflow for richer Health data.

Receipts identify the `source` (currently `apple_health`) and `record_count`.
The count field replaces `workout_count`, including in an `empty` response. The
phone's upload URL and `{"workouts":[...]}` request body stay the same. Admins can
read any receipt at `GET /v1/batches/<batch-id>`; the existing workout receipt URL
also continues to work for Apple Health.

## Schedule uploads

After a manual upload and vault check succeed, create a Shortcuts personal
automation: **Time of Day → Weekly** (recommended), or **Monthly → Run Immediately
→ Run Shortcut**. Keep failures visible and test a scheduled run on your phone.

Health reads may fail while the phone is locked. Keep the shortcut manually
runnable, and export a historical window if a gap exceeds your 60-day lookback.
The status monitor flags uploads older than 14 days, so monthly schedules need
that threshold taken into account.

## Developer documentation

- [Design](docs/DESIGN.md): components, ownership, end-to-end flow, and future importer.
- [Implementation](docs/IMPL.md): credentials, API, source map, delivery internals, and testing.
- [Review](docs/REVIEW.md): implementation review findings and verification history.
- [Journal](docs/JOUNRAL.md): dated implementation changes, decisions, and remaining work.
