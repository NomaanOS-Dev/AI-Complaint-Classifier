# NomaanOS AI Complaint Solver — Production Deployment Guide (`nomaanos.org`)

This guide documents the **₹0/month** production deployment architecture, environment variables, build/start commands, database migration workflow, DNS/HTTPS setup, security precautions, and free-tier limitations for **NomaanOS AI Complaint Solver**.

---

## 1. Project Architecture

NomaanOS is a 3-service monorepo backed by PostgreSQL:

- **`apps/web` (`complaints.nomaanos.org`)**: Next.js `16.4.2` / React `19.2.0` web application. Includes client-rendered dashboard, pricing/billing, analytics, integrations, docs, and dynamic SSR routes (`/contact/[token]`, `/complaints/[id]`, `/api/health`).
- **`services/api` (`api-complaints.nomaanos.org`)**: Node 22 + Express 5 REST API (`services/api/src/server.ts`). Uses `express-session` with `connect-pg-simple` (`user_sessions` table), runs SQL migrations on boot, handles Razorpay subscriptions/webhooks, and runs **3 in-process background polling workers** (`webhook-worker`, `inbound-email-worker`, `complaint-analysis-worker`).
- **`services/ai` (Internal / Secret-Protected)**: Python `3.12` FastAPI + Uvicorn service (`services/ai/app/main.py`). Calls Google Gemini or OpenAI to classify complaints, score priority (0–100), and draft replies. Protects `POST /analyze` with `AI_SERVICE_SECRET` via the `x-ai-service-token` header.
- **PostgreSQL 17**: Primary database (`pgcrypto` extension, 14 sequential SQL migrations `001`–`014`, session storage, complaints, AI results, billing & monthly usage counters).
- **File Storage**: None. NomaanOS does not store uploaded files on local disk.

---

## 2. Services and Responsibilities

| Service | Port | Responsibility | Statefulness |
|---|---|---|---|
| `apps/web` | `3000` | UI, pricing/billing checkout, public contact form | Stateless |
| `services/api` | `4000` | Auth, RBAC, complaints, billing, Razorpay webhooks, 3 background workers | Persistent process + PostgreSQL sessions |
| `services/ai` | `8000` | AI complaint classification (`/analyze`, `/health`) | Stateless |
| PostgreSQL | `5432` | Persistent data + `user_sessions` | Persistent |

---

## 3. Recommended Free-Tier Hosting Architecture (₹0/month)

| Component | Recommended Free Host | Custom Domain | Why This Choice |
|---|---|---|---|
| **Frontend** (`complaints.nomaanos.org`) | **Cloudflare Workers** (`@opennextjs/cloudflare`) — *or* **Render Free Web Service** | `complaints.nomaanos.org` | Cloudflare Free **permits commercial SaaS** (Vercel Hobby strictly prohibits commercial use). Render Free Web Service runs Next.js SSR with zero adapter changes, but shares Render's 750 hrs/month limit and sleeps after 15 min idle. |
| **Backend API** (`api-complaints.nomaanos.org`) | **Render Free Web Service** (Docker) | `api-complaints.nomaanos.org` | Runs a persistent Node process for Express + the 3 background workers, includes free managed TLS, and 750 free instance hours/month. |
| **AI Service** (Protected by `AI_SERVICE_SECRET`) | **Koyeb Free Nano** (Docker) | Default `*.koyeb.app` | Keeps Render's 750 hours dedicated to `services/api`. `POST /analyze` rejects any request missing `x-ai-service-token`. |
| **PostgreSQL** | **Neon Free Tier** | Internal DB URL | **1 GB storage**, **100 CU-hours/month**, persistent storage (**does not expire after 30 days**, unlike Render Free Postgres). |
| **DNS & TLS** | **Cloudflare Free** | `nomaanos.org` | Free DNS management, DDoS protection, and `Full (strict)` TLS. |
| **Email Delivery** | **Resend Free Tier** | `nomaanos.org` | 3,000 emails/month (100/day) for verification & password reset emails. |

---

## 4. Required Environment Variables

Reference the verified template files (placeholders only):
- Root: [`.env.example`](file:///d:/Projects/3-AI-Complaints-Classifications/.env.example)
- Frontend: [`apps/web/.env.example`](file:///d:/Projects/3-AI-Complaints-Classifications/apps/web/.env.example)
- Backend API: [`services/api/.env.example`](file:///d:/Projects/3-AI-Complaints-Classifications/services/api/.env.example)
- AI Service: [`services/ai/.env.example`](file:///d:/Projects/3-AI-Complaints-Classifications/services/ai/.env.example)

Key production values for `nomaanos.org`:
- `apps/web` (Public): `NEXT_PUBLIC_API_URL=https://api-complaints.nomaanos.org`, `NEXT_PUBLIC_AI_URL=` *(empty so browsers do not ping localhost)*, `NEXT_PUBLIC_RAZORPAY_KEY_ID`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
- `services/api` (Secret): `NODE_ENV=production`, `DATABASE_URL=...sslmode=require`, `SESSION_SECRET` (48+ random bytes), `WEB_ORIGIN=https://complaints.nomaanos.org`, `PUBLIC_FORM_BASE_URL=https://complaints.nomaanos.org/contact`, `PUBLIC_API_BASE_URL=https://api-complaints.nomaanos.org`, `AI_SERVICE_URL=https://<your-app>.koyeb.app`, `AI_SERVICE_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `RESEND_API_KEY`, `EMAIL_FROM=NomaanOS <noreply@nomaanos.org>`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
- `services/ai` (Secret): `AI_SERVICE_SECRET` *(exact match with API)*, `AI_PROVIDER=gemini` *(or `openai`)*, `GEMINI_API_KEY` *(or `OPENAI_API_KEY`)*

---

## 5. Build and Start Commands

### Frontend (`apps/web`)
- **Build:** `npm install && npm run build --workspace @nomaanos/web`
- **Start (Node/Render):** `npm run start --workspace @nomaanos/web`
- **Docker:** `apps/web/Dockerfile` (build context `.`)

### Backend API (`services/api`)
- **Build:** `npm install && npm run build --workspace @nomaanos/api`
- **Start:** `npm run start --workspace @nomaanos/api` (`node dist/src/server.js`)
- **Docker (Recommended on Render):** `services/api/Dockerfile` (build context `.`, copies `src/migrations` to `./migrations`)

### AI Service (`services/ai`)
- **Install:** `pip install --no-cache-dir -r services/ai/requirements.txt`
- **Start:** `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- **Docker (Recommended on Koyeb):** `services/ai/Dockerfile` (build context `.`)

---

## 6. Health-Check URLs & Expected Responses

| Service | Endpoint | Expected HTTP & JSON |
|---|---|---|
| Frontend | `GET https://complaints.nomaanos.org/api/health` | `200` `{"status":"ok","service":"web"}` |
| Backend API | `GET https://api-complaints.nomaanos.org/health` | `200` `{"status":"ok","service":"api","database":"ok"}` |
| AI Service | `GET https://<your-app>.koyeb.app/health` | `200` `{"status":"ok","service":"ai",...}` |

---

## 7. Database Setup and Migration Procedure

1. Create a PostgreSQL 17 project in **Neon** and copy the connection string (`?sslmode=require`).
2. Migrations `001-foundation.sql` through `014-subscriptions-billing.sql` are **idempotent** (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO UPDATE`) and use `CREATE EXTENSION IF NOT EXISTS pgcrypto` (supported on Neon).
3. Run migrations manually from PowerShell before or during deployment:
```powershell
cd D:\Projects\3-AI-Complaints-Classifications\services\api
npm.cmd run build
$env:DATABASE_URL="postgresql://<user>:<password>@<host>/<db>?sslmode=require"
npm.cmd run migrate
```
4. `services/api/src/server.ts` also runs `migrate()` automatically on startup with a PostgreSQL advisory lock (`pg_advisory_lock`).

---

## 8. DNS Records (`nomaanos.org` on Cloudflare)

| Type | Name | Target / Value | Proxy Status |
|---|---|---|---|
| `CNAME` | `complaints` | Target from Cloudflare Workers or Render Web | Proxied (after TLS verifies) |
| `CNAME` | `api-complaints` | `<your-render-api>.onrender.com` | **DNS Only** during initial TLS issuance, then Proxied (`Full (strict)`) |
| `TXT` / `MX` | `@` / `resend._domainkey` | Provided by **Resend → Domains → nomaanos.org** | DNS Only |

---

## 9. OAuth & Email Configuration Requirements

- **Google OAuth (`console.cloud.google.com`)**:
  - Authorized JavaScript origins: `https://complaints.nomaanos.org`
  - Authorized redirect URI: `https://complaints.nomaanos.org/auth/callback/google`
- **Resend (`resend.com`)**:
  - Verify `nomaanos.org` domain (SPF + DKIM) before setting `EMAIL_FROM=NomaanOS <noreply@nomaanos.org>`.
- **Razorpay (`dashboard.razorpay.com`)**:
  - Start in **Test Mode**. Set webhook URL to `https://api-complaints.nomaanos.org/webhooks/razorpay` with `RAZORPAY_WEBHOOK_SECRET`.

---

## 10. Security Precautions

1. Never commit `.env` or place `RAZORPAY_KEY_SECRET`, `SESSION_SECRET`, `AI_SERVICE_SECRET`, or `DATABASE_URL` in `NEXT_PUBLIC_*` variables.
2. Always set `NODE_ENV=production` on `services/api` so session cookies enforce `secure: true`, `httpOnly: true`, `sameSite: "none"`, and `trust proxy = 1`.
3. Set `AI_SERVICE_SECRET` identically on both `services/api` and `services/ai` so `POST /analyze` cannot be called by external users.
4. Keep `RAZORPAY_KEY_ID` in Test Mode (`rzp_test_...`) until end-to-end verification is complete.

---

## 11. Known Free-Tier Limitations & Deployment Risks

1. **Cold Starts / Sleeping Services:** Render Free Web Service sleeps after **15 minutes** of inactivity (30–60s cold start). Koyeb Free Nano sleeps after **1 hour** of inactivity (1–5s wake).
2. **Background Workers Pause During Sleep:** While `services/api` is asleep on Render Free, the 3 background polling workers (`webhook-worker`, `inbound-email-worker`, `complaint-analysis-worker`) pause until the next HTTP request wakes the service.
3. **No Production SLA:** Render Free, Koyeb Free, and Neon Free are intended for evaluation/early MVPs without uptime SLAs.
4. **AI API Usage Billing:** Hosting is ₹0/month, but LLM API calls consume tokens (Gemini offers a free tier with rate limits; OpenAI requires prepaid credits).
5. **Private Networking:** True VPC/private-only networking between `services/api` and `services/ai` requires paid plans on Render/Koyeb; `AI_SERVICE_SECRET` provides application-layer authentication over HTTPS at ₹0/month.
