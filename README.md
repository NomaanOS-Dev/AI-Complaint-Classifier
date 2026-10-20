# NomaanOS

NomaanOS is a complaint intelligence SaaS. The Day 1 foundation provides a Next.js web app, an Express API, a FastAPI service, PostgreSQL, versioned SQL migrations, and Docker Compose health checks. Day 2 adds secure user accounts, private workspaces, membership roles, and server-managed sessions. Complaint workflows remain for a later milestone.

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
