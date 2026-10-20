# digital-data-uploader

Upload Apple Health workout summaries from an iPhone Shortcut and save them in
your private `digital-data-vault` GitHub repository. The server processes the
Shortcut's existing JSON; the phone only finds workouts, builds JSON, and sends it.

Phone uploads and manual delivery to the vault have been tested locally. Cloud
deployment and scheduled phone runs still need verification. Importing these
files into `digital-data-dump` reports is a separate, future step.

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

## Connect your iPhone

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
