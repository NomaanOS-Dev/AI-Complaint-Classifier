# NomaanOS

NomaanOS is a complaint intelligence SaaS. This repository currently contains the Day 1 foundation: a Next.js web app, an Express API, a FastAPI service, PostgreSQL, migrations, and Docker Compose health checks. Authentication and complaint workflows are intentionally left for later milestones.

## Prerequisites

- Docker Desktop with Docker Compose
- Node.js 20.9 or newer and npm (needed for local build checks)

Python is not required on the host when using Docker Compose.

## Start the services

1. Copy `.env.example` to `.env`.
2. Change `POSTGRES_PASSWORD` in `.env` to a local development password and use the same password in `DATABASE_URL`.
3. Run `docker compose up --build` from the repository root.
4. Open <http://localhost:3000>.

The API is at <http://localhost:4000/health> and the AI service is at <http://localhost:8001/health>. PostgreSQL is available on localhost port 5433. These host ports can be changed in `.env` if they are already in use. On the first API start, SQL migrations are applied before the API begins accepting requests.

To stop the services, press Ctrl+C and run `docker compose down`. Database data remains in the `postgres_data` volume. To remove that local data as well, run `docker compose down -v`.

## Local build checks

Run `npm install`, then `npm run typecheck` and `npm run build`. The FastAPI container is built by Docker Compose; the host does not need Python installed.

## Services

| Service | Local URL | Health check |
| --- | --- | --- |
| Web | http://localhost:3000 | `/api/health` |
| API | http://localhost:4000 | `/health` (includes database connectivity) |
| AI | http://localhost:8001 | `/health` |
| PostgreSQL | localhost:5433 | Compose `pg_isready` check |
