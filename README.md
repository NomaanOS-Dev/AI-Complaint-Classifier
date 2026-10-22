# NomaanOS

NomaanOS is a complaint intelligence SaaS with a Next.js web app, an Express API, a FastAPI analysis service, PostgreSQL, versioned SQL migrations, secure user accounts, private workspaces, and complaint workflows.

## Prerequisites

- Docker Desktop with Docker Compose
- Node.js 20.9 or newer and npm (needed for local build checks)

Python is not required on the host when using Docker Compose.

## Start the services

1. Copy `.env.example` to `.env` if you are setting up a fresh checkout.
2. Set `POSTGRES_PASSWORD` and use the same password in `DATABASE_URL`.
3. Replace the `SESSION_SECRET` placeholder with a random secret of at least 32 bytes. Keep `.env` private.
4. Run `docker compose up --build -d` from the repository root.
5. Open <http://localhost:3000> and choose **Create account**.

The API is at <http://localhost:4000/health> and the AI service is at <http://localhost:8001/health>. PostgreSQL is available on localhost port 5433. These host ports can be changed in `.env` if they are already in use. On the first API start, SQL migrations are applied before the API begins accepting requests.

Migrations run before the API starts. The `002-auth.sql` migration creates users, workspaces, memberships, and the PostgreSQL-backed session store. Existing migrations are not edited.

To stop the services, run `docker compose down`. Database data remains in the `postgres_data` volume.

## Authentication and workspaces

- Register at `/register`; registration creates the user, first workspace, and `owner` membership in one database transaction.
- Sign in at `/login`; the authenticated dashboard is at `/dashboard`.
- Sessions are stored in PostgreSQL and sent in an HttpOnly, SameSite=Lax cookie. The API requires a session-bound CSRF token for state-changing requests. Cookies are Secure when `NODE_ENV=production`.
- Email addresses are trimmed and lowercased before storage; the normalized value is unique.
- Roles are `owner`, `admin`, and `member`. Owners and admins may update workspace settings; all workspace members may read that workspace. A user without membership receives `404` for workspace-specific access.
- Workspace IDs from the browser are always checked against the logged-in user's membership on the server.
- Authentication routes are rate limited to 10 attempts per 15 minutes per client IP.
- The current rate-limit counter uses the API process's in-memory store. Login and registration attempts share that counter; a process restart clears it, and multiple API replicas would each keep separate counters. Before scaling a production deployment or relying on lockout state across restarts, configure a shared rate-limit store. The 10-attempt limit remains enabled in this setup.
- Rate-limit keys use Express's `req.ip`. Forwarded headers are not trusted in local development; Docker Desktop may present host traffic to the container through a shared bridge address, so multiple local clients can share one IP quota. Production trusts one configured proxy hop only when `NODE_ENV=production`; set this to match the actual trusted proxy topology before deployment.

## Local build checks

Run `npm install`, then `npm run typecheck`, `npm test`, and `npm run build`. The API integration tests create a process-specific temporary schema in the configured PostgreSQL database and drop only that schema after the tests; they do not truncate or reset development tables. The FastAPI container is built by Docker Compose; the host does not need Python installed.

## Services

| Service | Local URL | Health check |
| --- | --- | --- |
| Web | http://localhost:3000 | `/api/health` |
| API | http://localhost:4000 | `/health` (includes database connectivity) |
| AI | http://localhost:8001 | `/health` |
| PostgreSQL | localhost:5433 | Compose `pg_isready` check |

## Complaint management

- Open `/complaints` while signed in. Choose an active workspace from the authenticated `/workspaces` response; complaint requests are always scoped to that workspace on the API.
- All workspace members may create and read complaints. Only owners and admins may update complaint status, following the existing workspace settings role policy.
- Complaints start in `open`; allowed status values are `open`, `in_progress`, `resolved`, and `closed`. Owners/admins may set any allowed value.
- The API uses `GET` and `POST /workspaces/:workspaceId/complaints`, `GET /workspaces/:workspaceId/complaints/:complaintId`, `PATCH /workspaces/:workspaceId/complaints/:complaintId/status`, and `GET /workspaces/:workspaceId/complaints/:complaintId/activity`. Listing supports `limit` (default 20, max 50), `offset`, `status`, and `q` filters.
- Migration `003-complaints.sql` creates the complaints table and workspace indexes without changing the existing migrations or records.

## Day 5 complaint activity timeline

- Migration `005-complaint-activity.sql` adds append-only complaint activity events without editing prior migrations. Existing complaints are preserved and are not assigned invented history; their timeline is empty until an event is recorded.
- Complaint creation, status transitions, and successful requested analysis are recorded with the acting user and timestamp. Complaint creation and its event are atomic. Status changes and their event are committed in one transaction; a no-op status update does not create a transition event. Successful analysis persistence and its event are also committed together.
- `GET /workspaces/:workspaceId/complaints/:complaintId/activity` requires a session and workspace membership. It returns chronological events and uses a stable event-ID cursor: `limit` defaults to 20 and accepts 1–50; `cursor` is the last event ID returned by the previous page.
- Activity metadata contains only small event-specific fields such as previous and new status. It does not contain complaint bodies, credentials, or provider response details. Timeline reads include an actor display name when available and remain scoped to the complaint's workspace.

## Day 6 workspace analytics

- Open `/analytics` from the signed-in dashboard or use the workspace's Analytics link. The page summarizes complaints created within the selected date range and provides daily volume, current status, saved AI category, priority, and severity distributions.
- `GET /workspaces/:workspaceId/analytics/overview` requires authentication and workspace membership; every aggregate is restricted to that workspace. Optional `startDate` and `endDate` values use `YYYY-MM-DD` UTC calendar dates, with both endpoints inclusive. If omitted, the range is the most recent 30 UTC calendar days including today. Ranges must be ordered and no longer than 366 days.
- The resolution rate is (currently resolved + currently closed complaints) divided by all complaints created in the selected range. It is `null` when that range has no complaints. Unresolved means currently open or in progress. Trend counts group complaints by UTC creation date; other breakdowns use current complaint status and the latest saved analysis, if any.
- Average resolution time is measured from complaint creation to its first recorded transition into `resolved` or `closed`, and only includes complaints currently in a terminal status with both a recorded creation event and a qualifying status event. Older complaints without complete activity history are excluded; the API returns the sample size and returns `null` when no reliable samples exist. No AI analysis is inferred or generated by analytics.
- Analytics uses bounded parameterized aggregate queries and does not add a database migration or new package dependency.

## Day 7 integration foundations

Migration `006-integrations.sql` adds workspace integration settings, API credentials, idempotency records, webhook endpoints, persistent deliveries, and attempt history. It preserves existing complaints and activity events. Credential and webhook management requires a signed-in workspace owner or admin plus the normal CSRF token. Integration credentials can only submit complaints; they cannot manage credentials, settings, or webhooks.

### API credentials and complaint ingestion

Set `INTEGRATION_ENCRYPTION_KEY` in the API environment before creating webhooks. Generate a dedicated base64 key with 32 random bytes (PowerShell: `[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`). Keep it out of source control and backups that are accessible to the application. The API uses it for AES-256-GCM encryption of signing secrets. Keep the key stable and backed up: changing it without decrypting and re-encrypting stored values makes existing webhook secrets unusable. If it is missing or invalid, webhook creation and rotation return `503`; API credential ingestion still works.

In `/integrations`, owners and admins can create credentials, optionally with an expiry, list metadata, revoke, and rotate. A credential is 256 random bits and is stored only as a SHA-256 hash plus a public lookup prefix. The secret is returned once. Rotation creates the replacement and revokes the old credential in one transaction; there is no overlap/grace period, and the new credential inherits the previous expiry. An expired credential must be replaced by creating a new one. Revocation is immediate for subsequent requests. List responses never contain a hash or secret.

Management routes are `GET/PATCH /workspaces/:workspaceId/integrations/settings`, `GET/POST /workspaces/:workspaceId/integrations/credentials`, `POST /workspaces/:workspaceId/integrations/credentials/:credentialId/revoke`, and `POST /workspaces/:workspaceId/integrations/credentials/:credentialId/rotate`. The integration credential is never accepted by these routes; they require the existing authenticated user session, CSRF protection for writes, and owner/admin role.

Send a complaint with a bearer credential and a unique `Idempotency-Key` (1–128 visible ASCII characters):

```sh
curl -X POST http://localhost:4000/api/v1/integrations/complaints \
  -H 'Authorization: Bearer nos_live_<public-prefix>_<secret>' \
  -H 'Idempotency-Key: crm-ticket-7842' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Package arrived damaged","description":"The item was damaged on arrival.","customer_email":"customer@example.test"}'
```

The versioned endpoint accepts only `title`, `description`, and optional `customer_email`; it rejects workspace IDs and unknown fields. The credential determines the workspace. Requests are JSON-limited by the existing 32 KiB API parser and use the existing complaint constraints. Ingestion records a `complaint_created` activity event and enqueues subscribed webhook deliveries in the same database transaction. It does not call the AI service.

The first successful request returns `201` with `{"complaint":{"id":"…","status":"open","createdAt":"…"}}`. A same-key, same-normalized-payload replay returns the same JSON with `200` and `Idempotent-Replayed: true`. A same-key request with a different normalized title, description, or email returns `409`. Keys are scoped to workspace and credential, enforced by a PostgreSQL advisory transaction lock plus a unique constraint, and retained for 30 days. Expired keys are removed on reuse and by the API worker's periodic cleanup; replay after expiry can create another complaint.

### Webhook setup, payload, and signatures

Webhook endpoints are configured in `/integrations`. A subscription must select one or more implemented event types: `complaint_created`, `status_changed`, and `analysis_completed`. The persistent delivery queue is populated transactionally from the existing activity event. Payloads contain a stable event UUID, type, workspace ID, event timestamp, complaint ID, and status transition fields where applicable; they omit complaint text, customer email, API credentials, and signing secrets. For example:

```json
{"id":"event-uuid","type":"status_changed","workspaceId":"workspace-uuid","occurredAt":"2026-10-20T10:00:00.000Z","data":{"complaintId":"complaint-uuid","previousStatus":"open","newStatus":"in_progress"}}
```

Each endpoint gets a random `whsec_…` signing secret that is encrypted at rest with AES-256-GCM and shown only at creation or rotation. Rotating a webhook secret immediately invalidates the previous one. The request includes `X-NomaanOS-Timestamp` (Unix seconds), `X-NomaanOS-Signature` (`t=<timestamp>,v1=<lowercase-hex-HMAC>`), and `X-NomaanOS-Event-Id`. The HMAC-SHA256 input is the exact UTF-8 byte sequence `<timestamp>.<raw-request-body>` and the key is the signing secret as UTF-8. Verify the timestamp is within a short replay window (for example, five minutes), parse the `v1` value, compare it to a freshly calculated HMAC using a constant-time comparison, and deduplicate using the event ID. The receiver must verify the raw body before JSON parsing or reserialization. Example Node verification core:

```js
const expected = createHmac("sha256", signingSecret)
  .update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
const valid = Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300 &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(receivedV1));
```

The API worker runs in the API process and polls PostgreSQL with `FOR UPDATE SKIP LOCKED` and 60-second leases, so another API process can recover an expired lease after a worker crash. Delivery is at-least-once: if a receiver accepts a request and the worker crashes before saving success, it may be sent again. Receivers must deduplicate by event ID. Automatic retries are limited to eight attempts. Network/timeouts, HTTP 408/425/429, and 5xx responses retry using exponential delay `1 second × 2^(attempt−1)`, randomized between 50% and 100%, capped at one hour. Other HTTP responses, including redirects, are permanent failures. Requests have an 8-second total deadline, response reads are capped at 2 KiB, and logs store only a generic result summary (never response bodies). Owners and admins can inspect recent workspace delivery logs and manually retry a failed delivery after correcting its endpoint. Terminal delivery and attempt logs are retained for 180 days; pending jobs are not aged out.

Webhook routes are `GET/POST /workspaces/:workspaceId/integrations/webhooks`, `PATCH/DELETE /workspaces/:workspaceId/integrations/webhooks/:webhookId`, `POST /workspaces/:workspaceId/integrations/webhooks/:webhookId/rotate-secret`, `GET /workspaces/:workspaceId/integrations/deliveries`, and `POST /workspaces/:workspaceId/integrations/deliveries/:deliveryId/retry`. Workspace-scoped composite foreign keys prevent associating a delivery with an endpoint or event from another workspace.

### Integration rate and URL security

The `/integrations` settings let owners/admins disable ingestion or configure a shared workspace limit of 1–600 requests per minute (default 60). A PostgreSQL counter shared by all credentials and API replicas enforces the limit. Excess valid-credential requests return `429` with `Retry-After` seconds until the next UTC-aligned minute. Limits include valid credential requests that later fail body validation or replay an idempotency key.

Webhook URLs may not contain username/password, query strings, or fragments. Unless `NODE_ENV` is explicitly `development` or `test`, only HTTPS is accepted (including when `NODE_ENV` is unset). Before saving and before each delivery, the API resolves DNS with a 3-second bound and rejects non-global IPv4/IPv6 addresses, including loopback, private, link-local, reserved, and metadata ranges. Each delivery pins the connection to one of the checked addresses, preserves TLS hostname verification/SNI, and does not follow redirects. Every A/AAAA answer must pass validation. In development/test only, explicit localhost HTTP is allowed for local tests. Do not use this development exception in production.

### Day 7 limitations

- The worker shares the API process and database pool; PostgreSQL locking supports multiple API replicas, but queue throughput, backlog alerting, and operational dashboards are not provided.
- Delivery is at-least-once, not exactly-once. Receivers must deduplicate by stable event ID.
- Changing `INTEGRATION_ENCRYPTION_KEY` requires a planned re-encryption migration; there is no key-version/key-rotation workflow yet. Back up the key separately and restrict access.
- DNS is checked at endpoint save and immediately before each send, then the selected IP is pinned for that connection. This reduces DNS rebinding risk, but the custom IP classification and deployment proxy/network path still need independent security review and production egress controls.
- The API currently accepts no custom webhook headers and rejects URL query strings to avoid bearer tokens being embedded in URLs. Development localhost delivery from inside Docker targets the API container's own loopback; use a controlled receiver reachable by the API container for manual end-to-end delivery checks.
- This is an integration foundation, not a compliance certification. Review key management, egress policy, queue capacity, retention, and alerts for the actual deployment before production use.

## Day 4 complaint analysis

- A workspace member can read saved analysis or explicitly request/re-request it through `GET` and `POST /workspaces/:workspaceId/complaints/:complaintId/analysis`. The POST is session-authenticated, CSRF-protected, workspace-scoped, and runs only when requested; failed calls do not change the complaint or overwrite prior saved analysis.
- FastAPI exposes `POST /analyze`. `AI_PROVIDER` selects `openai` (default) or `gemini`; the selected provider uses the official OpenAI Python SDK Responses API or Google GenAI Python SDK respectively. Both return the same strict structured analysis contract, which FastAPI and Express validate. Set only the selected provider's API key in the server-side environment: `OPENAI_API_KEY` with optional `OPENAI_MODEL` (default `gpt-6.1-sol`), or `GEMINI_API_KEY` with optional `GEMINI_MODEL` (default `gemini-3.1-flash-lite`). Docker Compose passes these variables only to the AI service, not to the frontend. If the selected key is missing, analysis returns a safe configuration error and the last successful saved analysis remains available. Provider selection does not automatically fall back to another provider.
- For Gemini, Google currently documents `gemini-3.1-flash-lite` as a supported model with structured JSON output. Model availability, quotas, pricing, and free-tier eligibility depend on Google's current offering and your account; verify them in the official [model documentation](https://ai.google.dev/gemini-api/docs/models) and [pricing](https://ai.google.dev/gemini-api/docs/pricing) before enabling live use. Gemini retries only transient 429/5xx errors, at most twice after the initial request, with bounded backoff and a 25-second overall deadline. OpenAI keeps retries disabled and uses a 25-second client timeout.
- In your existing private `.env`, set `AI_PROVIDER=gemini` and `GEMINI_API_KEY` to your Gemini key to select Gemini. To switch back, set `AI_PROVIDER=openai` and configure `OPENAI_API_KEY`. Keep both keys server-side; do not place either in a `NEXT_PUBLIC_*` variable, browser code, or source control. Follow your provider's current billing, usage, and data handling terms.
- Analysis is probabilistic. The prompt asks the model to use the full complaint context and a documented heuristic priority rubric: low for routine/minimal impact, medium for meaningful non-urgent issues, high for substantial impact or urgent/repeated disruption, and critical for credible safety, fraud, or account-security risk. Labels must match existing thresholds: low below 25, medium 25–49, high 50–79, urgent 80–100. The score is not scientifically calibrated and should be evaluated against representative complaints before operational use.
- Model output is schema-validated in FastAPI and validated again by Express before persistence. Express uses `AI_SERVICE_TIMEOUT_MS` (default 30 seconds, maximum 30 seconds); provider requests have a 25-second maximum, with bounded transient retries for Gemini and none for OpenAI. The API avoids logging complaint text and prevents concurrent duplicate analysis requests within one API process. The latest successful analysis remains stored per complaint; failures do not overwrite it.
- Analysis is stored as one latest result per complaint. Re-analysis replaces that row after the new response passes server validation. Migration `004-complaint-analysis.sql` preserves existing complaints.
- Suggested replies are editable drafts for a human to review or copy. They are never sent automatically. The model has no tools, database access, or authority to determine user/workspace authorization. Complaint text is treated as untrusted input.

### Tests and optional live smoke test

Build the AI image and run mocked tests without an API key or provider charges:

```sh
docker compose build ai
docker compose run --rm ai python -m unittest discover -s tests -p 'test_*.py'
```

An optional live smoke test is separate from the normal test suite. Set `AI_PROVIDER` and that provider's server-side key, then explicitly enable the matching live request. This sends a real provider request and may incur charges or count against quotas:

```sh
docker compose run --rm -e RUN_GEMINI_LIVE_TEST=1 ai python tests/live_smoke.py
```

For OpenAI, use `RUN_OPENAI_LIVE_TEST=1` instead. Mocked tests verify provider selection, request construction, schema and contract validation, bounded Gemini retries, and safe error handling. They do not prove real model accuracy or response quality. A live smoke test confirms only that one configured request returned a validated response; it is not an evaluation.

## Day 8 public forms and inbound email

Migration `007-contact-email-ingestion.sql` adds public contact-form tokens, workspace inbound-email routes, request throttles, inbound event processing records, and complaint customer-name/category fields. It broadens the complaint source constraint to include `contact_form` and `inbound_email` while preserving historical records.

### Hosted contact form

An owner or admin opens **Integrations** and selects **Create contact form link**. The API returns a random 256-bit token once; only its SHA-256 hash is retained. The hosted form is served at:

```text
http://localhost:3000/contact/<one-time-token>
```

The link is public, so copy it into the customer's support site or share it securely. Rotating the link immediately invalidates the old link. Disabling the form revokes it. The public endpoint resolves the workspace from the hashed form token and rejects caller-supplied workspace identity.

```text
GET  /public/contact/:token
POST /public/contact/:token
```

Example request:

```json
{
  "name": "Customer Example",
  "email": "customer@example.test",
  "subject": "Order arrived damaged",
  "description": "The package arrived with a broken item.",
  "category": "delivery",
  "website": ""
}
```

Send an `Idempotency-Key` header (1–128 visible ASCII characters). Matching replays return the same minimal receipt; changed payload reuse returns `409`. Records expire after seven days. Contact submissions are limited to 8 per client IP per form per 15 minutes and 200 per workspace per 15 minutes; `429` includes `Retry-After`. A hidden honeypot field named `website` is silently accepted without creating a complaint. Requests are bounded at 12 KB. CAPTCHA is not implemented or enabled.

Contact submissions create a complaint with source `contact_form`, add an activity event, and enqueue configured `complaint_created` webhooks in one transaction. Name, email, optional category, subject, and description are validated server-side. No AI analysis runs automatically.

### Embed & Integrate Form

Open **Integrations → Embed & Integrate Form**. The wizard offers two methods:

- **Embed Form** creates an additional public form in the selected workspace using the same hashed public-token, rate-limit, validation, idempotency, and revocation flow as the hosted contact form. It does not rotate or replace the existing hosted-form link. Configure the display name and optional name/email/category fields; complaint title and description stay required. Add the exact website origins allowed to frame the form (HTTPS origins, with localhost HTTP allowed for local testing). The `/contact/:token` page sends a route-specific `Content-Security-Policy: frame-ancestors` containing only `'self'` and those allowed origins. Your own site may also need to permit the NomaanOS form origin in its `frame-src` policy. The URL contains a public form token, not an API credential; it is rate-limited and can be rotated or revoked by a workspace owner/admin.
- **Connect Existing Form** keeps your site's form and sends submissions from your backend to `POST /api/v1/integrations/complaints`. The selected workspace API credential is stored hashed by NomaanOS and shown only once when created. It belongs on your server in a secret manager or server-only environment variable. Never place it in HTML, browser JavaScript, a React client component, a `NEXT_PUBLIC_*` variable, or a public repository. Revoke and rotate it if it may have been exposed.

The wizard provides HTML/JavaScript, React, Next.js, and generic server examples. Browser examples call your own backend route; they never send the NomaanOS Bearer credential. The Next.js example uses a server Route Handler at `app/api/complaints/route.ts`, reads `NOMAANOS_API_URL` and `NOMAANOS_API_CREDENTIAL` only on the server, validates the request, applies an eight-second timeout, and returns a sanitized error. Add these values to `.env.local` for local development and your platform's server-side secret manager in production. Keep the API URL HTTPS in production. Do not expose the credential through `NEXT_PUBLIC_` variables. For a NomaanOS deployment, set `PUBLIC_FORM_BASE_URL` to the externally reachable form base and configure the web service's `API_INTERNAL_URL` to a trusted API address reachable from the web server; the contact-page frame policy fails closed if that lookup is unavailable.

To test, submit a clearly labeled test complaint and confirm it appears in the selected workspace. The ingestion API requires a 1–128 visible ASCII `Idempotency-Key`: the same key and payload returns `200` with the saved receipt; changing the payload under the same key returns `409`. Invalid request fields return `400`, missing/invalid/expired/revoked credentials return `401`, disabled workspace integrations return `403`, rate limits return `429` with `Retry-After`, and successful new submissions return `201`. Retrying a network failure with the same key is safe. The wizard does not offer a credential test button because the API has no separate credential-validation endpoint.

Migration `008-embed-contact-forms.sql` adds per-form configuration and allows multiple embed forms while retaining the existing single hosted contact-form record and existing form token system. Existing hosted links and their stored hashes are preserved.

### Customer backend integration

For a customer's backend or serverless function, use a Day 7 workspace API credential and keep it in the backend's secret store. Do not put that key in HTML, browser JavaScript, or `NEXT_PUBLIC_*` variables.

```js
const response = await fetch("https://nomaan.example/api/v1/integrations/complaints", {
  method: "POST",
  headers: {
    "authorization": `Bearer ${process.env.NOMAANOS_API_CREDENTIAL}`,
    "content-type": "application/json",
    "idempotency-key": `support-ticket/${ticket.id}`
  },
  body: JSON.stringify({
    title: ticket.subject,
    description: ticket.description,
    customer_email: ticket.customerEmail
  })
});

if (!response.ok) throw new Error(`NomaanOS ingestion failed: ${response.status}`);
const result = await response.json();
```

Use a stable ticket identifier for the idempotency key and retry `429` or server errors with backoff. The credential determines the workspace. The existing credential permissions, shared workspace limit, validation, and 30-day idempotency retention remain in effect.

### Resend inbound email

The API uses the official Resend Node SDK to verify webhook signatures and the official receiving endpoint to retrieve inbound bodies. The retrieval call is pinned to Resend's HTTPS API host, rejects redirects, times out, and reads at most 1 MB before JSON parsing. Resend documents a managed receiving subdomain `<id>.resend.app` and says it accepts any username at that subdomain. NomaanOS creates a unique `nomaan-<random-token>@<configured-domain>` address per workspace. Confirm receiving is enabled and verify this address format in your Resend account before relying on it; the UI reports `awaiting provider setup` until external setup is done. See [Resend receiving setup](https://resend.com/docs/dashboard/receiving/introduction) and the [webhook verification guide](https://resend.com/docs/webhooks/verify-webhooks-requests).

The API service reads these variables (configure them in the API runtime's secret/environment manager, never in the frontend):

- `RESEND_API_KEY` — server-side API key with inbound email retrieval access.
- `RESEND_WEBHOOK_SECRET` — signing secret for the Resend webhook subscribed to `email.received`.
- `RESEND_INBOUND_DOMAIN` — the receiving domain shown in the Resend account.
- `INTEGRATION_ENCRYPTION_KEY` — existing 32-byte base64 key used to encrypt the recoverable inbound address at rest.
- `PUBLIC_FORM_BASE_URL` — optional hosted form base URL; Compose defaults to `http://localhost:3000/contact`.

After configuring the domain in Resend, open **Integrations** and create an inbound address. The address is encrypted at rest and its routing token is stored as a hash. It is visible only to authorized workspace owners/admins in the integrations UI. Rotating or disabling it invalidates the route. The UI displays `awaiting provider setup`, `disabled`, or `not configured`; it never claims provider delivery is configured based only on local database state.

Create a Resend webhook in **Webhooks**, select `email.received`, and set its endpoint to `https://<your-api-host>/webhooks/resend`. Copy the webhook signing secret into `RESEND_WEBHOOK_SECRET`. The endpoint verifies the exact raw body and the `svix-id`, `svix-timestamp`, and `svix-signature` headers through `resend.webhooks.verify`; missing, invalid, and stale signatures are rejected. The API acknowledges only after the event is durably stored. There is no unsigned-development bypass.

For a local test, first configure a trusted HTTPS development tunnel to port 4000 yourself, then use its HTTPS URL plus `/webhooks/resend` in Resend. Do not expose the development API publicly until you have deliberately chosen and secured a tunnel. Send a real email to the workspace address, then check the Resend Receiving dashboard and **Inbound email** in NomaanOS Integrations. Local code and health checks alone do not prove real email delivery.

The worker retrieves the body through Resend's receiving API, verifies the retrieved recipient matches the active workspace route, and creates a complaint with source `inbound_email` plus an activity event. It does not auto-run AI analysis or send a reply. Provider event IDs, email IDs, and workspace/message IDs have uniqueness constraints; processing uses row locks and retryable state. Temporary provider/database errors retry with exponential delays starting at 15 seconds, capped at one hour, for at most eight attempts. UI logs expose status/error codes and sanitized attachment metadata, not message contents.

Email loop suppression applies to `Auto-Submitted` values other than `no`, `Precedence` values `bulk`, `list`, or `junk`, known `mailer-daemon`/`postmaster` senders, delivery-status report headers, or the `X-NomaanOS-Generated` marker. A `no-reply` sender alone is not suppressed. Repeated provider email IDs or message IDs are treated as duplicates.

Attachments are **metadata-only**: filenames are reduced to safe basenames, declared count/size and MIME types are checked, and unsupported types are marked. No attachment bytes are downloaded or stored, and no download URL from email content or webhook payload is fetched. Customers cannot download attachments from NomaanOS. This remains intentional until private, tenant-scoped binary storage exists.

### Day 8 limitations and troubleshooting

- Resend account setup, webhook registration, tunnel exposure, and end-to-end delivery are external steps and are not performed by this implementation.
- CAPTCHA is not configured; the honeypot and persistent rate limits are the available abuse controls. Add a verified CAPTCHA before broad public exposure if your threat model requires it.
- Contact throttling uses the API's observed client IP. In production, configure the trusted reverse-proxy topology expected by `trust proxy`; do not accept arbitrary forwarded IP headers.
- Inbound processing needs both `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`; the endpoint fails closed if either is missing. Queue records are durable and recoverable after restart.
- If the UI says `not configured`, set the API-side inbound domain. `awaiting provider setup` means the route exists locally but external delivery has not been verified.
- The project has no private binary storage yet. Inbound attachments are metadata only and cannot be downloaded.

### Day 9 Meta WhatsApp and Instagram inbox

NomaanOS ingests inbound messages from WhatsApp Cloud API and Instagram Messaging into workspace complaints. Workspace owners and admins connect WhatsApp through **Integrations → WhatsApp and Instagram → Connect WhatsApp**. Instagram remains a manual professional-account mapping. Signed Meta webhook account IDs—not workspace identity supplied in an event—determine the destination workspace.

#### WhatsApp Embedded Signup prerequisites

Configure the Meta app before enabling signup:

1. Add WhatsApp and Facebook Login for Business products to the Meta app. Create an Embedded Signup **v4** configuration for the Cloud API and request `whatsapp_business_management` and `whatsapp_business_messaging`. Meta advanced access, business verification, and review may be required for production use.
2. In the Meta app’s Facebook Login for Business settings, allow the public NomaanOS web origin and configure the deployment’s exact HTTPS OAuth redirect/allowed-domain settings as required by the selected configuration. Meta Embedded Signup requires a publicly reachable HTTPS deployment; localhost is for local development only.
3. Configure the Meta app’s Webhooks product for WhatsApp `messages` and `account_update`, using `https://<your-api-host>/webhooks/meta`, then complete Meta’s callback verification. The app-level subscription and NomaanOS’s WABA-level subscription are both required.
4. Configure the Meta environment values below on the API service. Set `WEB_ORIGIN` to the public HTTPS dashboard origin and `PUBLIC_API_BASE_URL` to the public HTTPS API origin.

| Variable | Purpose |
| --- | --- |
| `META_APP_ID` | Public Meta app ID used to initialize the browser SDK |
| `META_APP_SECRET` | Server-only app secret for OAuth code exchange, token validation, and webhook signatures |
| `META_LOGIN_CONFIG_ID` | Facebook Login for Business Embedded Signup v4 configuration ID |
| `META_GRAPH_API_VERSION` | Graph API version; `.env.example` currently uses `v26.0` |
| `META_TOKEN_ENCRYPTION_KEY` | Server-only base64 encoding of exactly 32 random bytes for AES-256-GCM token encryption |
| `META_WEBHOOK_VERIFY_TOKEN` | Private value shared with Meta's webhook callback verification |
| `PUBLIC_API_BASE_URL` | Public HTTPS API origin; callback path is `/webhooks/meta` |
| `WEB_ORIGIN` | Public HTTPS dashboard origin allowed by Meta |

Keep app secrets, webhook verification tokens, and encryption keys in the API environment only. Browser code receives only the app ID, configuration ID, and Graph API version. WhatsApp access tokens are validated server-side, encrypted at rest, and excluded from API responses. Onboarding state is random, single-use, expires after ten minutes, and is bound to the authenticated user and workspace. The API verifies the granted app and permissions, confirms the selected phone number belongs to the selected WABA, and subscribes the app to that WABA before saving the connection. A globally connected phone number cannot be claimed by another workspace. Disconnect unsubscribes the WABA and clears the stored encrypted token while retaining connection/message history.

The token expiry is recorded, but automatic token refresh is not implemented. Reconnect before expiry if Meta issues an expiring token. If configuration is incomplete, the dashboard lists the required server-side settings and does not simulate a successful connection.

The webhook uses Meta's GET challenge handshake and rejects POST requests with missing or invalid signatures against the exact raw request body. It accepts bounded payloads, acknowledges only after durable processing, and returns a retryable `503` for database failures. Duplicate provider message IDs are idempotent.

Incoming messages create a complaint and subsequent messages from the same sender/account are added to that complaint's activity timeline. Inbound events do not trigger AI analysis, replies, or outbound messages. WhatsApp status notifications and Instagram echoes are ignored. Attachments are metadata-only: media bytes and URLs are not fetched or stored. A connection becomes active after its first successfully processed inbound message; pending means no successful message has been received yet.

Use the official setup documentation for the exact current Meta product requirements:
[WhatsApp Embedded Signup overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview),
[Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4),
[WhatsApp Cloud API webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/),
[Instagram Messaging webhooks](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/), and
[Graph API webhooks setup](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/).
Requirements for account eligibility, permissions, subscriptions, and app review are controlled by Meta and can change independently of NomaanOS.

Migrations `009-meta-social-inbox.sql` and `010-whatsapp-embedded-signup.sql` are additive; they do not remove or rewrite earlier migrations.

### Day 9 limitations and verification

- Configure Meta's callback as `https://<your-api-host>/webhooks/meta`; use the same verification token in the dashboard and `META_WEBHOOK_VERIFY_TOKEN`.
- Complete the required Meta app dashboard configuration, business verification, permissions, and review. These external setup steps are not automated by NomaanOS.
- Connect WhatsApp from the workspace Integrations dashboard after setting the required environment variables. Configure Instagram by adding its professional account ID separately.
- A mismatch between the configured WhatsApp business account and webhook mapping is rejected and does not create a complaint. Disconnected or unknown accounts are not ingested.
- Automated tests mock Graph API responses and use signed local webhook fixtures with isolated database schemas. They do not make live Meta API calls or prove app configuration, permissions, callback reachability, or real message delivery. Perform a controlled test only after configuring Meta and a public HTTPS callback.
