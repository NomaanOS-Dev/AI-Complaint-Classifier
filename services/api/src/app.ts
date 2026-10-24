import argon2 from "argon2";
import connectPgSimple from "connect-pg-simple";
import cors from "cors";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import session from "express-session";
import { databaseIsReady, pool } from "./db.js";
import { mountDay8Routes } from "./day8-routes.js";
import { mountMetaSocialRoutes, mountMetaWebhook } from "./meta-social.js";
import { createWhatsAppGraphApi, mountWhatsAppSignupRoutes, type WhatsAppGraphApi } from "./meta-whatsapp.js";
import { mountResendWebhook } from "./resend-webhook.js";
import {
  encryptWebhookSecret, generateIntegrationCredential, hashIntegrationCredential,
  hasIntegrationEncryptionKey, integrationEventTypes, isValidCredentialFormat, resolveSafeWebhookUrl
} from "./integration-security.js";
import { enqueueComplaintAnalysis, persistComplaintAnalysis } from "./complaint-analysis-worker.js";

const PgSessionStore = connectPgSimple(session);
const SESSION_COOKIE = "nomaanos.sid";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dummyPasswordHash = argon2.hash(randomBytes(32).toString("hex"), { type: argon2.argon2id });

type UserRow = { id: string; name: string; email: string };
type WorkspaceRow = { id: string; name: string; role?: "owner" | "admin" | "member"; created_at?: string };
type ComplaintRow = {
  id: string; workspace_id: string; title: string; description: string; customer_email: string | null;
  customer_name?: string | null; submitted_category?: string | null;
  source: "manual" | "contact_form" | "inbound_email" | "whatsapp" | "instagram"; status: "open" | "in_progress" | "resolved" | "closed"; created_by: string;
  created_at: string; updated_at: string;
  analysis_status?: string | null; analysis_error?: string | null; analysis_model_name?: string | null;
};
type ComplaintListRow = ComplaintRow & {
  analysis_category: string | null; analysis_priority_label: string | null;
  analysis_priority_score: number | null; analysis_analyzed_at: string | null;
  analysis_model_name?: string | null; analysis_status?: string | null; analysis_error?: string | null;
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const complaintStatuses = ["open", "in_progress", "resolved", "closed"] as const;
const complaintEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const analysisCategories = ["payment", "refund", "delivery", "account", "technical", "product_quality", "other"] as const;
const analysisSentiments = ["positive", "neutral", "negative"] as const;
const analysisSeverities = ["low", "medium", "high", "critical"] as const;
const analysisPriorityLabels = ["low", "medium", "high", "urgent"] as const;
const activeAnalysisRequests = new Set<string>();
const analyticsDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const integrationIdempotencyTtlDays = 30;
type ComplaintAnalysis = {
  category: typeof analysisCategories[number]; sentiment: typeof analysisSentiments[number]; severity: typeof analysisSeverities[number];
  priority_score: number; priority_label: typeof analysisPriorityLabels[number]; reasoning_summary: string;
  suggested_reply: string; model_name: string; analyzed_at: string;
};

function validComplaintAnalysis(value: unknown): value is ComplaintAnalysis {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const analysis = value as Record<string, unknown>;
  const expectedKeys = ["category", "sentiment", "severity", "priority_score", "priority_label", "reasoning_summary", "suggested_reply", "model_name", "analyzed_at"];
  if (Object.keys(analysis).length !== expectedKeys.length || expectedKeys.some((key) => !(key in analysis))) return false;
  const score = analysis.priority_score;
  const expectedLabel = typeof score === "number" && score < 25 ? "low" : typeof score === "number" && score < 50 ? "medium" : typeof score === "number" && score < 80 ? "high" : "urgent";
  return analysisCategories.includes(analysis.category as typeof analysisCategories[number]) &&
    analysisSentiments.includes(analysis.sentiment as typeof analysisSentiments[number]) &&
    analysisSeverities.includes(analysis.severity as typeof analysisSeverities[number]) &&
    typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= 100 &&
    analysisPriorityLabels.includes(analysis.priority_label as typeof analysisPriorityLabels[number]) && analysis.priority_label === expectedLabel &&
    typeof analysis.reasoning_summary === "string" && analysis.reasoning_summary.trim().length >= 1 && analysis.reasoning_summary.length <= 300 &&
    typeof analysis.suggested_reply === "string" && analysis.suggested_reply.trim().length >= 1 && analysis.suggested_reply.length <= 1200 &&
    typeof analysis.model_name === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(analysis.model_name) &&
    typeof analysis.analyzed_at === "string" && Number.isFinite(Date.parse(analysis.analyzed_at)) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(analysis.analyzed_at);
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrfToken?: string;
  }
}

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res, next)).catch(next);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function tokenMatches(expected: string | undefined, supplied: string | undefined) {
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (!tokenMatches(req.session.csrfToken, req.get("x-csrf-token"))) {
    res.status(403).json({ error: "CSRF validation failed" });
    return;
  }
  next();
}

function regenerateSession(req: Request) {
  return new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

function saveSession(req: Request) {
  return new Promise<void>((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });
}

type DbClient = import("pg").PoolClient;

async function enqueueWebhookDeliveries(client: DbClient, eventId: string, workspaceId: string) {
  await client.query(
    `INSERT INTO webhook_deliveries (workspace_id, endpoint_id, event_id, payload)
     SELECT e.workspace_id, h.id, e.id,
       jsonb_build_object('id', e.id, 'type', e.event_type, 'workspaceId', e.workspace_id,
         'occurredAt', e.occurred_at,
         'data', jsonb_build_object('complaintId', e.complaint_id) ||
           CASE WHEN e.event_type = 'status_changed' THEN jsonb_build_object(
             'previousStatus', e.metadata->>'previous_status', 'newStatus', e.metadata->>'new_status') ELSE '{}'::jsonb END)
     FROM complaint_activity_events e JOIN webhook_endpoints h ON h.workspace_id = e.workspace_id
     WHERE e.id = $1 AND e.workspace_id = $2 AND h.enabled = true AND h.deleted_at IS NULL
       AND e.event_type = ANY(h.event_types)
     ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
    [eventId, workspaceId]
  );
}

function validIdempotencyKey(value: string | undefined): value is string {
  return Boolean(value && value.length <= 128 && /^[\x21-\x7e]+$/.test(value));
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  void pool.query<UserRow>("SELECT id, name, email FROM users WHERE id = $1", [userId]).then(({ rows }) => {
    if (!rows[0]) {
      req.session.destroy(() => undefined);
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    res.locals.user = rows[0];
    next();
  }).catch(next);
}

function requireWorkspaceRole(allowedRoles: Array<"owner" | "admin" | "member">) {
  return asyncRoute(async (req, res, next) => {
    const user = res.locals.user as UserRow;
    const workspaceId = String(req.params.workspaceId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const result = await pool.query<{ role: "owner" | "admin" | "member" }>(
      "SELECT role FROM tenant_memberships WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, user.id]
    );
    const membership = result.rows[0];
    if (!membership) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    if (!allowedRoles.includes(membership.role)) {
      res.status(403).json({ error: "Insufficient workspace role" });
      return;
    }
    res.locals.workspaceRole = membership.role;
    next();
  });
}

export function createApp(options: { metaGraphFetch?: typeof fetch; whatsappGraphApi?: WhatsAppGraphApi } = {}) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || Buffer.byteLength(sessionSecret) < 32) {
    throw new Error("SESSION_SECRET must be configured with at least 32 bytes");
  }

  const app = express();
  mountResendWebhook(app);
  mountMetaWebhook(app, enqueueWebhookDeliveries);
  const isProduction = process.env.NODE_ENV === "production";
  const origin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many authentication attempts. Try again later." }
  });

  if (isProduction) app.set("trust proxy", 1);
  app.use(cors({ origin, credentials: true, exposedHeaders: ["Retry-After"] }));
  app.use(express.json({ limit: "32kb" }));
  app.use(session({
    name: SESSION_COOKIE,
    secret: sessionSecret,
    store: new PgSessionStore({ pool, tableName: "user_sessions", createTableIfMissing: false }),
    resave: false,
    saveUninitialized: false,
    cookie: {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  maxAge: SESSION_MAX_AGE,
}
  }));

  app.get("/health", async (_req, res) => {
    try {
      await databaseIsReady();
      res.json({ status: "ok", service: "api", database: "ok" });
    } catch {
      res.status(503).json({ status: "error", service: "api", database: "unavailable" });
    }
  });

  mountDay8Routes(app, { requireAuth, csrfProtection, requireWorkspaceRole, enqueueWebhookDeliveries });
  const whatsappGraphApi = options.whatsappGraphApi ?? createWhatsAppGraphApi(options.metaGraphFetch ?? fetch);
  mountMetaSocialRoutes(app, { requireAuth, csrfProtection, requireWorkspaceRole, enqueueWebhookDeliveries, whatsappGraphApi });
  mountWhatsAppSignupRoutes(app, {
    requireAuth, csrfProtection, requireWorkspaceRole,
    graphApi: whatsappGraphApi
  });

  app.get("/auth/csrf", (req, res) => {
    req.session.csrfToken ??= randomBytes(32).toString("hex");
    res.json({ csrfToken: req.session.csrfToken });
  });

  app.post("/auth/register", authLimiter, csrfProtection, asyncRoute(async (req, res) => {
    const { name, email, password, workspaceName } = req.body ?? {};
    const normalizedEmail = typeof email === "string" ? normalizeEmail(email) : "";
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100 ||
        !emailPattern.test(normalizedEmail) || normalizedEmail.length > 254 ||
        typeof password !== "string" || password.length < 12 || password.length > 128 ||
        typeof workspaceName !== "string" || workspaceName.trim().length < 1 || workspaceName.trim().length > 120) {
      res.status(400).json({ error: "Enter a valid name, email, password (12–128 characters), and workspace name." });
      return;
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const client = await pool.connect();
    let user: UserRow;
    let workspace: WorkspaceRow;
    try {
      await client.query("BEGIN");
      const userResult = await client.query<UserRow>(
        "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
        [name.trim(), normalizedEmail, passwordHash]
      );
      user = userResult.rows[0];
      const workspaceResult = await client.query<WorkspaceRow>(
        "INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name",
        [workspaceName.trim()]
      );
      workspace = workspaceResult.rows[0];
      await client.query("INSERT INTO tenant_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace.id, user.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "Unable to register with those details." });
        return;
      }
      throw error;
    } finally {
      client.release();
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.csrfToken = randomBytes(32).toString("hex");
    await saveSession(req);
    res.status(201).json({ user, workspace: { ...workspace, role: "owner" }, csrfToken: req.session.csrfToken });
  }));

  app.post("/auth/login", authLimiter, csrfProtection, asyncRoute(async (req, res) => {
    const { email, password } = req.body ?? {};
    const normalizedEmail = typeof email === "string" ? normalizeEmail(email) : "";
    const userResult = emailPattern.test(normalizedEmail)
      ? await pool.query<{ id: string; name: string; email: string; password_hash: string }>("SELECT id, name, email, password_hash FROM users WHERE email = $1", [normalizedEmail])
      : { rows: [] as Array<{ id: string; name: string; email: string; password_hash: string }> };
    const user = userResult.rows[0];
    const verificationHash = user?.password_hash ?? await dummyPasswordHash;
    const validPassword = typeof password === "string"
      ? await argon2.verify(verificationHash, password).catch(() => false)
      : false;
    if (!user || !validPassword) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.csrfToken = randomBytes(32).toString("hex");
    await saveSession(req);
    res.json({ user: { id: user.id, name: user.name, email: user.email }, csrfToken: req.session.csrfToken });
  }));

  app.post("/auth/logout", csrfProtection, asyncRoute(async (req, res) => {
    await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: isProduction, sameSite: isProduction ? "none" : "lax", path: "/" });
    res.status(204).end();
  }));

  app.get("/auth/me", requireAuth, (_req, res) => res.json({ user: res.locals.user }));

  app.get("/workspaces", requireAuth, asyncRoute(async (_req, res) => {
    const user = res.locals.user as UserRow;
    const result = await pool.query<WorkspaceRow>(
      `SELECT w.id, w.name, w.created_at, m.role
       FROM workspaces w JOIN tenant_memberships m ON m.workspace_id = w.id
       WHERE m.user_id = $1 ORDER BY w.created_at, w.id`, [user.id]
    );
    res.json({ workspaces: result.rows });
  }));

  app.post("/workspaces", csrfProtection, requireAuth, asyncRoute(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 120) {
      res.status(400).json({ error: "Workspace name must be between 1 and 120 characters." });
      return;
    }
    const user = res.locals.user as UserRow;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<WorkspaceRow>("INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name, created_at", [name.trim()]);
      const workspace = result.rows[0];
      await client.query("INSERT INTO tenant_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace.id, user.id]);
      await client.query("COMMIT");
      res.status(201).json({ workspace: { ...workspace, role: "owner" } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/workspaces/:workspaceId", requireAuth, requireWorkspaceRole(["owner", "admin", "member"]), asyncRoute(async (req, res) => {
    const result = await pool.query<WorkspaceRow>("SELECT id, name, created_at FROM workspaces WHERE id = $1", [String(req.params.workspaceId)]);
    if (!result.rows[0]) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    res.json({ workspace: { ...result.rows[0], role: res.locals.workspaceRole } });
  }));

  app.get("/workspaces/:workspaceId/analytics/overview", requireAuth, requireWorkspaceRole(["owner", "admin", "member"]), asyncRoute(async (req, res) => {
    const parseDate = (value: unknown) => {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || !analyticsDatePattern.test(value)) return null;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
    };
    const requestedStart = parseDate(req.query.startDate);
    const requestedEnd = parseDate(req.query.endDate);
    if (requestedStart === null || requestedEnd === null) {
      res.status(400).json({ error: "Dates must be valid UTC calendar dates in YYYY-MM-DD format." });
      return;
    }
    const today = new Date();
    const defaultEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const end = requestedEnd ?? defaultEnd;
    const start = requestedStart ?? new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
    const dayCount = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (dayCount < 1 || dayCount > 366) {
      res.status(400).json({ error: "Date range must be ordered and no longer than 366 days." });
      return;
    }
    const endExclusive = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    const workspaceId = String(req.params.workspaceId);
    const [overview, trend] = await Promise.all([
      pool.query(`
        WITH scoped AS MATERIALIZED (
          SELECT c.id, c.status, c.created_at, ca.category, ca.priority_label, ca.severity
          FROM complaints c LEFT JOIN complaint_analyses ca ON ca.complaint_id = c.id
          WHERE c.workspace_id = $1 AND c.created_at >= $2 AND c.created_at < $3
        ), resolution_events AS (
          SELECT e.complaint_id, min(e.occurred_at) AS resolved_at
          FROM complaint_activity_events e
          JOIN scoped s ON s.id = e.complaint_id
          WHERE e.workspace_id = $1 AND e.event_type = 'status_changed'
            AND e.metadata->>'new_status' IN ('resolved', 'closed')
          GROUP BY e.complaint_id
        ), reliable_resolution AS (
          SELECT s.id, extract(epoch FROM (r.resolved_at - s.created_at)) / 3600.0 AS hours
          FROM scoped s JOIN resolution_events r ON r.complaint_id = s.id
          WHERE s.status IN ('resolved', 'closed') AND r.resolved_at >= s.created_at
            AND EXISTS (SELECT 1 FROM complaint_activity_events e
                        WHERE e.complaint_id = s.id AND e.workspace_id = $1 AND e.event_type = 'complaint_created')
        )
        SELECT
          (SELECT count(*)::int FROM scoped) AS total,
          (SELECT count(*)::int FROM scoped WHERE status = 'open') AS open,
          (SELECT count(*)::int FROM scoped WHERE status = 'in_progress') AS in_progress,
          (SELECT count(*)::int FROM scoped WHERE status = 'resolved') AS resolved,
          (SELECT count(*)::int FROM scoped WHERE status = 'closed') AS closed,
          (SELECT count(*)::int FROM scoped WHERE status IN ('open', 'in_progress')) AS unresolved,
          (SELECT count(*)::int FROM scoped WHERE status IN ('resolved', 'closed')) AS terminal,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('category', category, 'count', n) ORDER BY category), '[]'::jsonb)
             FROM (SELECT category, count(*)::int AS n FROM scoped WHERE category IS NOT NULL GROUP BY category) categories) AS categories,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('label', priority_label, 'count', n) ORDER BY priority_label), '[]'::jsonb)
             FROM (SELECT priority_label, count(*)::int AS n FROM scoped WHERE priority_label IS NOT NULL GROUP BY priority_label) priorities) AS priorities,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('label', severity, 'count', n) ORDER BY severity), '[]'::jsonb)
             FROM (SELECT severity, count(*)::int AS n FROM scoped WHERE severity IS NOT NULL GROUP BY severity) severities) AS severities,
          (SELECT avg(hours)::float8 FROM reliable_resolution) AS average_resolution_hours,
          (SELECT count(*)::int FROM reliable_resolution) AS resolution_sample_size
      `, [workspaceId, start.toISOString(), endExclusive.toISOString()]),
      pool.query(`
        SELECT days.day::date::text AS date, count(c.id)::int AS count
        FROM generate_series($2::date, ($3::date - interval '1 day')::date, interval '1 day') AS days(day)
        LEFT JOIN complaints c ON c.workspace_id = $1 AND c.created_at >= days.day
          AND c.created_at < days.day + interval '1 day'
        GROUP BY days.day ORDER BY days.day
      `, [workspaceId, start.toISOString(), endExclusive.toISOString()])
    ]);
    const row = overview.rows[0];
    const total = Number(row.total);
    const terminal = Number(row.terminal);
    res.json({
      dateRange: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), timezone: "UTC" },
      totalComplaints: total,
      statusCounts: { open: Number(row.open), in_progress: Number(row.in_progress), resolved: Number(row.resolved), closed: Number(row.closed) },
      unresolvedCount: Number(row.unresolved),
      resolutionRate: total === 0 ? null : Math.round((terminal / total) * 1000) / 10,
      averageResolutionTimeHours: row.average_resolution_hours === null ? null : Number(row.average_resolution_hours),
      resolutionTimeSampleSize: Number(row.resolution_sample_size),
      categories: row.categories,
      priorities: row.priorities,
      severities: row.severities,
      trends: trend.rows.map((item: { date: string; count: number }) => ({ date: item.date, count: Number(item.count) }))
    });
  }));

  app.patch("/workspaces/:workspaceId", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 120) {
      res.status(400).json({ error: "Workspace name must be between 1 and 120 characters." });
      return;
    }
    const result = await pool.query<WorkspaceRow>(
      "UPDATE workspaces SET name = $1, updated_at = now() WHERE id = $2 RETURNING id, name, created_at", [name.trim(), String(req.params.workspaceId)]
    );
    res.json({ workspace: { ...result.rows[0], role: res.locals.workspaceRole } });
  }));

  app.get("/workspaces/:workspaceId/integrations/settings", requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const result = await pool.query<{ enabled: boolean; requests_per_minute: number }>(
      "SELECT enabled, requests_per_minute FROM workspace_integrations WHERE workspace_id = $1", [String(req.params.workspaceId)]
    );
    res.json({ settings: result.rows[0] ?? { enabled: true, requests_per_minute: 60 } });
  }));

  app.patch("/workspaces/:workspaceId/integrations/settings", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !["enabled", "requestsPerMinute"].includes(key)) ||
        (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
        (body.requestsPerMinute !== undefined && (!Number.isInteger(body.requestsPerMinute) || body.requestsPerMinute < 1 || body.requestsPerMinute > 600))) {
      res.status(400).json({ error: "Settings accept enabled and requestsPerMinute (1–600)." });
      return;
    }
    const current = await pool.query<{ enabled: boolean; requests_per_minute: number }>(
      "SELECT enabled, requests_per_minute FROM workspace_integrations WHERE workspace_id = $1", [String(req.params.workspaceId)]
    );
    const result = await pool.query(
      `INSERT INTO workspace_integrations (workspace_id, enabled, requests_per_minute)
       VALUES ($1, $2, $3) ON CONFLICT (workspace_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, requests_per_minute = EXCLUDED.requests_per_minute, updated_at = now()
       RETURNING enabled, requests_per_minute`,
      [String(req.params.workspaceId), body.enabled ?? current.rows[0]?.enabled ?? true,
        body.requestsPerMinute ?? current.rows[0]?.requests_per_minute ?? 60]
    );
    res.json({ settings: result.rows[0] });
  }));

  app.get("/workspaces/:workspaceId/integrations/credentials", requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, key_prefix, created_at, last_used_at, expires_at, revoked_at, rotated_to
       FROM integration_credentials WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`, [String(req.params.workspaceId)]
    );
    res.json({ credentials: result.rows });
  }));

  app.post("/workspaces/:workspaceId/integrations/credentials", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== "string" || !Number.isFinite(Date.parse(body.expiresAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(body.expiresAt)) {
        res.status(400).json({ error: "expiresAt must be an ISO timestamp with a timezone." });
        return;
      }
      expiresAt = new Date(body.expiresAt);
      if (expiresAt <= new Date()) { res.status(400).json({ error: "Credential expiry must be in the future." }); return; }
    }
    if (Object.keys(body).some((key) => !["name", "expiresAt"].includes(key)) || typeof body.name !== "string" || body.name.trim().length < 1 || body.name.trim().length > 100) {
      res.status(400).json({ error: "Credential name must be 1–100 characters; expiresAt is optional." });
      return;
    }
    const generated = generateIntegrationCredential();
    const user = res.locals.user as UserRow;
    const result = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO integration_credentials (workspace_id, name, key_prefix, secret_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [String(req.params.workspaceId), body.name.trim(), generated.prefix, generated.hash, user.id, expiresAt]
    );
    res.status(201).json({ credential: { id: result.rows[0].id, name: body.name.trim(), prefix: generated.prefix,
      created_at: result.rows[0].created_at, last_used_at: null, expires_at: expiresAt, revoked_at: null }, secret: generated.token,
      warning: "Copy this credential now. It cannot be displayed again." });
  }));

  app.post("/workspaces/:workspaceId/integrations/credentials/:credentialId/revoke", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const id = String(req.params.credentialId);
    if (!uuidPattern.test(id)) { res.status(404).json({ error: "Credential not found" }); return; }
    const result = await pool.query(
      `UPDATE integration_credentials SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING id, revoked_at`,
      [id, String(req.params.workspaceId)]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Credential not found or already revoked" }); return; }
    res.json({ credential: result.rows[0] });
  }));

  app.post("/workspaces/:workspaceId/integrations/credentials/:credentialId/rotate", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const id = String(req.params.credentialId);
    if (!uuidPattern.test(id)) { res.status(404).json({ error: "Credential not found" }); return; }
    const generated = generateIntegrationCredential();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ id: string; name: string; expires_at: Date | null; revoked_at: Date | null }>(
        "SELECT id, name, expires_at, revoked_at FROM integration_credentials WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [id, String(req.params.workspaceId)]
      );
      const oldCredential = current.rows[0];
      if (!oldCredential || oldCredential.revoked_at || (oldCredential.expires_at && oldCredential.expires_at <= new Date())) {
        await client.query("ROLLBACK"); res.status(404).json({ error: "Active credential not found" }); return;
      }
      const user = res.locals.user as UserRow;
      const replacement = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO integration_credentials (workspace_id, name, key_prefix, secret_hash, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [String(req.params.workspaceId), oldCredential.name, generated.prefix, generated.hash, user.id, oldCredential.expires_at]
      );
      await client.query("UPDATE integration_credentials SET revoked_at = now(), rotated_to = $2 WHERE id = $1", [id, replacement.rows[0].id]);
      await client.query("COMMIT");
      res.status(201).json({ credential: { id: replacement.rows[0].id, name: oldCredential.name, prefix: generated.prefix,
        created_at: replacement.rows[0].created_at, expires_at: oldCredential.expires_at }, secret: generated.token,
        warning: "The previous credential was revoked immediately. Copy this replacement now; it cannot be displayed again." });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }));

  app.get("/workspaces/:workspaceId/integrations/webhooks", requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT id, url, event_types, enabled, created_at, updated_at
       FROM webhook_endpoints WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
      [String(req.params.workspaceId)]
    );
    res.json({ webhooks: result.rows });
  }));

  app.post("/workspaces/:workspaceId/integrations/webhooks", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    try { if (!hasIntegrationEncryptionKey()) { res.status(503).json({ error: "Webhook secret encryption is not configured on the API." }); return; } }
    catch { res.status(503).json({ error: "Webhook secret encryption is not configured correctly on the API." }); return; }
    const { url, eventTypes } = req.body ?? {};
    if (typeof url !== "string" || !Array.isArray(eventTypes) || eventTypes.length < 1 || eventTypes.length > integrationEventTypes.length ||
        eventTypes.some((item: unknown) => !integrationEventTypes.includes(item as typeof integrationEventTypes[number])) || new Set(eventTypes).size !== eventTypes.length ||
        Object.keys(req.body ?? {}).some((key) => !["url", "eventTypes"].includes(key))) {
      res.status(400).json({ error: "Provide a valid URL and one or more supported eventTypes." }); return;
    }
    try { await resolveSafeWebhookUrl(url); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Unsafe webhook URL." }); return; }
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const user = res.locals.user as UserRow;
    const result = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO webhook_endpoints (workspace_id, url, event_types, signing_secret_ciphertext, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [String(req.params.workspaceId), url, eventTypes, encryptWebhookSecret(secret), user.id]
    );
    res.status(201).json({ webhook: { id: result.rows[0].id, url, event_types: eventTypes, enabled: true, created_at: result.rows[0].created_at }, signingSecret: secret,
      warning: "Copy this signing secret now. It cannot be displayed again." });
  }));

  app.patch("/workspaces/:workspaceId/integrations/webhooks/:webhookId", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const id = String(req.params.webhookId); const body = req.body ?? {};
    const keys = Object.keys(body);
    if (!uuidPattern.test(id) || !keys.length || keys.some((key) => !["url", "eventTypes", "enabled"].includes(key)) ||
        (body.url !== undefined && typeof body.url !== "string") || (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
        (body.eventTypes !== undefined && (!Array.isArray(body.eventTypes) || body.eventTypes.length < 1 || body.eventTypes.length > integrationEventTypes.length ||
          body.eventTypes.some((item: unknown) => !integrationEventTypes.includes(item as typeof integrationEventTypes[number])) || new Set(body.eventTypes).size !== body.eventTypes.length))) {
      res.status(400).json({ error: "Webhook updates accept a safe URL, supported eventTypes, or enabled." }); return;
    }
    const current = await pool.query<{ url: string; event_types: string[] }>(
      "SELECT url, event_types FROM webhook_endpoints WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
      [id, String(req.params.workspaceId)]
    );
    if (!current.rows[0]) { res.status(404).json({ error: "Webhook not found" }); return; }
    const url = body.url ?? current.rows[0].url; const eventTypes = body.eventTypes ?? current.rows[0].event_types;
    try { await resolveSafeWebhookUrl(url); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Unsafe webhook URL." }); return; }
    const updated = await pool.query(
      `UPDATE webhook_endpoints SET url = $3, event_types = $4, enabled = coalesce($5, enabled), updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
       RETURNING id, url, event_types, enabled, created_at, updated_at`,
      [id, String(req.params.workspaceId), url, eventTypes, body.enabled ?? null]
    );
    res.json({ webhook: updated.rows[0] });
  }));

  app.post("/workspaces/:workspaceId/integrations/webhooks/:webhookId/rotate-secret", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    try { if (!hasIntegrationEncryptionKey()) { res.status(503).json({ error: "Webhook secret encryption is not configured on the API." }); return; } }
    catch { res.status(503).json({ error: "Webhook secret encryption is not configured correctly on the API." }); return; }
    const id = String(req.params.webhookId);
    if (!uuidPattern.test(id)) { res.status(404).json({ error: "Webhook not found" }); return; }
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const updated = await pool.query(
      `UPDATE webhook_endpoints SET signing_secret_ciphertext = $3, updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, String(req.params.workspaceId), encryptWebhookSecret(secret)]
    );
    if (!updated.rows[0]) { res.status(404).json({ error: "Webhook not found" }); return; }
    res.json({ webhookId: id, signingSecret: secret, warning: "The previous signing secret is invalid immediately. Copy this replacement now; it cannot be displayed again." });
  }));

  app.delete("/workspaces/:workspaceId/integrations/webhooks/:webhookId", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const id = String(req.params.webhookId);
    if (!uuidPattern.test(id)) { res.status(404).json({ error: "Webhook not found" }); return; }
    const result = await pool.query(
      `UPDATE webhook_endpoints SET enabled = false, deleted_at = now(), signing_secret_ciphertext = '', updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL RETURNING id`, [id, String(req.params.workspaceId)]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Webhook not found" }); return; }
    res.status(204).end();
  }));

  app.get("/workspaces/:workspaceId/integrations/deliveries", requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const limitRaw = req.query.limit === undefined ? "20" : String(req.query.limit);
    const offsetRaw = req.query.offset === undefined ? "0" : String(req.query.offset);
    const limit = Number(limitRaw); const offset = Number(offsetRaw);
    const state = req.query.state === undefined ? null : String(req.query.state);
    if (!/^[1-9]\d*$/.test(limitRaw) || !Number.isInteger(limit) || limit > 50 || !/^(0|[1-9]\d*)$/.test(offsetRaw) || !Number.isSafeInteger(offset) || offset > 1000000 ||
        (state !== null && !["pending", "delivered", "failed"].includes(state))) {
      res.status(400).json({ error: "Invalid delivery filters." }); return;
    }
    const result = await pool.query(
      `SELECT d.id, d.endpoint_id, e.url, d.event_id, d.state, d.attempt_count, d.total_attempt_count,
              d.next_attempt_at, d.delivered_at, d.last_attempt_at, d.last_http_status, d.last_result, d.created_at,
              (SELECT count(*)::int FROM webhook_delivery_attempts a WHERE a.delivery_id = d.id) AS attempt_history_count
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE d.workspace_id = $1 AND ($2::text IS NULL OR d.state = $2)
       ORDER BY d.created_at DESC, d.id DESC LIMIT $3 OFFSET $4`,
      [String(req.params.workspaceId), state, limit, offset]
    );
    res.json({ deliveries: result.rows, pagination: { limit, offset } });
  }));

  app.post("/workspaces/:workspaceId/integrations/deliveries/:deliveryId/retry", csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const id = String(req.params.deliveryId);
    if (!uuidPattern.test(id)) { res.status(404).json({ error: "Delivery not found" }); return; }
    const result = await pool.query(
      `UPDATE webhook_deliveries SET state = 'pending', attempt_count = 0, next_attempt_at = now(), locked_until = NULL,
         last_result = NULL, updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND state = 'failed' RETURNING id, state, next_attempt_at`,
      [id, String(req.params.workspaceId)]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Failed delivery not found" }); return; }
    res.status(202).json({ delivery: result.rows[0] });
  }));

  app.post("/api/v1/integrations/complaints", asyncRoute(async (req, res) => {
    const authorization = req.get("authorization") ?? "";
    const bearer = authorization.match(/^Bearer (nos_live_[a-f0-9]{16}_[A-Za-z0-9_-]{43})$/i);
    if (!bearer || !isValidCredentialFormat(bearer[1])) { res.status(401).json({ error: "A valid integration credential is required." }); return; }
    const token = bearer[1];
    const tokenPrefix = token.match(/^nos_live_([a-f0-9]{16})_/)?.[1];
    if (!tokenPrefix) { res.status(401).json({ error: "A valid integration credential is required." }); return; }
    const credentialResult = await pool.query<{ id: string; workspace_id: string; created_by: string; secret_hash: Buffer }>(
      `SELECT id, workspace_id, created_by, secret_hash FROM integration_credentials
       WHERE key_prefix = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [tokenPrefix]
    );
    const credential = credentialResult.rows[0];
    const suppliedHash = hashIntegrationCredential(token);
    if (!credential || credential.secret_hash.length !== suppliedHash.length || !timingSafeEqual(credential.secret_hash, suppliedHash)) {
      res.status(401).json({ error: "A valid integration credential is required." }); return;
    }
    const settingsResult = await pool.query<{ enabled: boolean; requests_per_minute: number }>(
      "SELECT enabled, requests_per_minute FROM workspace_integrations WHERE workspace_id = $1", [credential.workspace_id]
    );
    const settings = settingsResult.rows[0] ?? { enabled: true, requests_per_minute: 60 };
    if (!settings.enabled) { res.status(403).json({ error: "Integrations are disabled for this workspace." }); return; }
    const credentialUse = await pool.query(
      `UPDATE integration_credentials SET last_used_at = now()
       WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING id`, [credential.id]
    );
    if (!credentialUse.rows[0]) { res.status(401).json({ error: "A valid integration credential is required." }); return; }
    const rate = await pool.query<{ request_count: number; retry_after: number }>(
      `INSERT INTO workspace_integration_rate_limits (workspace_id, window_started_at, request_count)
       SELECT $1, bucket.minute, 1 FROM (SELECT date_trunc('minute', clock_timestamp()) AS minute) bucket
       ON CONFLICT (workspace_id) DO UPDATE SET
         request_count = CASE WHEN workspace_integration_rate_limits.window_started_at < EXCLUDED.window_started_at THEN 1
                              ELSE workspace_integration_rate_limits.request_count + 1 END,
         window_started_at = CASE WHEN workspace_integration_rate_limits.window_started_at < EXCLUDED.window_started_at THEN EXCLUDED.window_started_at
                                  ELSE workspace_integration_rate_limits.window_started_at END,
         updated_at = now()
       RETURNING request_count,
         greatest(1, ceil(extract(epoch FROM (window_started_at + interval '1 minute' - clock_timestamp())))::int) AS retry_after`,
      [credential.workspace_id]
    );
    res.setHeader("RateLimit-Limit", String(settings.requests_per_minute));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, settings.requests_per_minute - rate.rows[0].request_count)));
    if (rate.rows[0].request_count > settings.requests_per_minute) {
      res.setHeader("Retry-After", String(rate.rows[0].retry_after));
      res.status(429).json({ error: "Workspace integration request limit exceeded. Retry after the current minute." }); return;
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => !["title", "description", "customer_email"].includes(key)) ||
        typeof body.title !== "string" || typeof body.description !== "string") {
      res.status(400).json({ error: "Provide only title, description, and optional customer_email; title and description are required." }); return;
    }
    const title = body.title.trim();
    const description = body.description.trim();
    const email = body.customer_email === undefined || body.customer_email === null ? null :
      typeof body.customer_email === "string" ? body.customer_email.trim().toLowerCase() : false;
    if (title.length < 1 || title.length > 200 || description.length < 1 || description.length > 10000 ||
        (email !== null && (typeof email !== "string" || email.length > 254 || !complaintEmailPattern.test(email)))) {
      res.status(400).json({ error: "Enter a title (1–200 characters), description (1–10000 characters), and optional valid customer email." }); return;
    }
    const idempotencyKey = req.get("idempotency-key");
    if (!validIdempotencyKey(idempotencyKey)) { res.status(400).json({ error: "Idempotency-Key is required and must contain 1–128 visible ASCII characters." }); return; }
    const normalizedPayload = { title, description, customer_email: email };
    const payloadHash = createHash("sha256").update(JSON.stringify(normalizedPayload)).digest("hex");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lockName = `${credential.workspace_id}:${credential.id}:${idempotencyKey}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockName]);
      await client.query(
        "DELETE FROM integration_idempotency WHERE workspace_id = $1 AND credential_id = $2 AND idempotency_key = $3 AND expires_at <= now()",
        [credential.workspace_id, credential.id, idempotencyKey]
      );
      const existing = await client.query<{ payload_hash: string; response_body: unknown }>(
        `SELECT payload_hash, response_body FROM integration_idempotency
         WHERE workspace_id = $1 AND credential_id = $2 AND idempotency_key = $3 FOR UPDATE`,
        [credential.workspace_id, credential.id, idempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== payloadHash) {
          await client.query("ROLLBACK"); res.status(409).json({ error: "Idempotency-Key was already used with a different request." }); return;
        }
        await client.query("COMMIT");
        res.setHeader("Idempotent-Replayed", "true"); res.status(200).json(existing.rows[0].response_body); return;
      }
      const complaintResult = await client.query<ComplaintRow>(
        `INSERT INTO complaints (workspace_id, title, description, customer_email, source, created_by)
         VALUES ($1, $2, $3, $4, 'manual', $5)
         RETURNING id, workspace_id, title, description, customer_email, source, status, created_by, created_at, updated_at`,
        [credential.workspace_id, title, description, email, credential.created_by]
      );
      const complaint = complaintResult.rows[0];
      const event = await client.query<{ id: string }>(
        `INSERT INTO complaint_activity_events (complaint_id, workspace_id, event_type, actor_user_id, metadata)
         VALUES ($1, $2, 'complaint_created', $3, $4::jsonb) RETURNING id`,
        [complaint.id, credential.workspace_id, credential.created_by, JSON.stringify({ integrationCredentialId: credential.id })]
      );
      await enqueueWebhookDeliveries(client, event.rows[0].id, credential.workspace_id);
      await enqueueComplaintAnalysis(client, complaint.id, credential.workspace_id);
      const responseBody = { complaint: { id: complaint.id, status: complaint.status, createdAt: complaint.created_at } };
      await client.query(
        `INSERT INTO integration_idempotency (workspace_id, credential_id, idempotency_key, payload_hash, complaint_id, response_body, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() + ($7::int * interval '1 day'))`,
        [credential.workspace_id, credential.id, idempotencyKey, payloadHash, complaint.id, JSON.stringify(responseBody), integrationIdempotencyTtlDays]
      );
      await client.query("COMMIT");
      res.status(201).json(responseBody);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }));

  // All workspace members may create/read complaints; only owners/admins may change status.
  app.post("/workspaces/:workspaceId/complaints", requireAuth, csrfProtection, requireWorkspaceRole(["owner", "admin", "member"]), asyncRoute(async (req, res) => {
    const { title, description, customer_email: customerEmail, source } = req.body ?? {};
    const normalizedTitle = typeof title === "string" ? title.trim() : "";
    const normalizedDescription = typeof description === "string" ? description.trim() : "";
    const normalizedEmail = typeof customerEmail === "string" ? customerEmail.trim().toLowerCase() : customerEmail;
    if (normalizedTitle.length < 1 || normalizedTitle.length > 200 || normalizedDescription.length < 1 || normalizedDescription.length > 10000 ||
        (customerEmail !== undefined && customerEmail !== null && (typeof normalizedEmail !== "string" || normalizedEmail.length > 254 || !complaintEmailPattern.test(normalizedEmail))) ||
        (source !== undefined && source !== "manual")) {
      res.status(400).json({ error: "Enter a title (1–200 characters), description (1–10000 characters), optional valid customer email, and source 'manual'." });
      return;
    }
    const user = res.locals.user as UserRow;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ComplaintRow>(
        `INSERT INTO complaints (workspace_id, title, description, customer_email, source, created_by)
         VALUES ($1, $2, $3, $4, 'manual', $5)
         RETURNING id, workspace_id, title, description, customer_email, source, status, created_by, created_at, updated_at`,
        [String(req.params.workspaceId), normalizedTitle, normalizedDescription, normalizedEmail ?? null, user.id]
      );
      const complaint = result.rows[0];
      const activity = await client.query<{ id: string }>(
        `INSERT INTO complaint_activity_events (complaint_id, workspace_id, event_type, actor_user_id, metadata)
         VALUES ($1, $2, 'complaint_created', $3, '{}'::jsonb) RETURNING id`,
        [complaint.id, complaint.workspace_id, user.id]
      );
      await enqueueWebhookDeliveries(client, activity.rows[0].id, complaint.workspace_id);
      await enqueueComplaintAnalysis(client, complaint.id, complaint.workspace_id);
      await client.query("COMMIT");
      res.status(201).json({ complaint: { ...complaint, analysis_status: "pending" } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/workspaces/:workspaceId/complaints", requireAuth, requireWorkspaceRole(["owner", "admin", "member"]), asyncRoute(async (req, res) => {
    const rawLimit = req.query.limit === undefined ? "20" : String(req.query.limit);
    const rawOffset = req.query.offset === undefined ? "0" : String(req.query.offset);
    const limit = Number(rawLimit);
    const offset = Number(rawOffset);
    const status = req.query.status === undefined ? undefined : String(req.query.status);
    const search = req.query.q === undefined ? "" : String(req.query.q).trim();
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isInteger(limit) || limit > 50 || !/^(0|[1-9]\d*)$/.test(rawOffset) || !Number.isSafeInteger(offset) || offset > 1000000 ||
        (status !== undefined && !complaintStatuses.includes(status as typeof complaintStatuses[number])) || search.length > 200) {
      res.status(400).json({ error: "Invalid complaint filters. Limit must be 1–50, offset 0–1000000, and status/search must be valid." });
      return;
    }
    const workspaceId = String(req.params.workspaceId);
    const result = await pool.query<ComplaintListRow>(
      `SELECT c.id, c.workspace_id, c.title, c.description, c.customer_name, c.customer_email, c.submitted_category, c.source, c.status, c.created_by, c.created_at, c.updated_at,
              ca.category AS analysis_category, ca.priority_label AS analysis_priority_label,
              ca.priority_score AS analysis_priority_score, ca.analyzed_at AS analysis_analyzed_at,
              ca.model_name AS analysis_model_name,
              j.status AS analysis_status, j.error_code AS analysis_error
       FROM complaints c
       LEFT JOIN complaint_analyses ca ON ca.complaint_id = c.id
       LEFT JOIN complaint_analysis_jobs j ON j.complaint_id = c.id
       WHERE c.workspace_id = $1
         AND ($2::text IS NULL OR c.status = $2)
         AND ($3::text = '' OR c.title ILIKE '%' || $3 || '%' OR c.description ILIKE '%' || $3 || '%')
       ORDER BY c.created_at DESC, c.id DESC LIMIT $4 OFFSET $5`,
      [workspaceId, status ?? null, search, limit + 1, offset]
    );
    res.json({ complaints: result.rows.slice(0, limit), pagination: { limit, offset, hasMore: result.rows.length > limit } });
  }));

  app.get("/workspaces/:workspaceId/complaints/:complaintId", requireAuth, requireWorkspaceRole(["owner", "admin", "member"]), asyncRoute(async (req, res) => {
    const complaintId = String(req.params.complaintId);
    if (!uuidPattern.test(complaintId)) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }
    const result = await pool.query<ComplaintRow>(
      `SELECT c.id, c.workspace_id, c.title, c.description, c.customer_name, c.customer_email, c.submitted_category, c.source, c.status, c.created_by, c.created_at, c.updated_at,
              ca.model_name AS analysis_model_name,
              j.status AS analysis_status, j.error_code AS analysis_error
       FROM complaints c
       LEFT JOIN complaint_analyses ca ON ca.complaint_id = c.id
       LEFT JOIN complaint_analysis_jobs j ON j.complaint_id = c.id
       WHERE c.id = $1 AND c.workspace_id = $2`,
      [complaintId, String(req.params.workspaceId)]
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }
    res.json({ complaint: result.rows[0] });
  }));

  app.get("/workspaces/:workspaceId/complaints/:complaintId/activity", requireAuth, requireWorkspaceRole(["owner", "admin", "member"]), asyncRoute(async (req, res) => {
    const complaintId = String(req.params.complaintId);
    if (!uuidPattern.test(complaintId)) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }
    const rawLimit = req.query.limit === undefined ? "20" : String(req.query.limit);
    const rawCursor = req.query.cursor === undefined ? undefined : String(req.query.cursor);
    const limit = Number(rawLimit);
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isInteger(limit) || limit > 50 ||
        (rawCursor !== undefined && !uuidPattern.test(rawCursor))) {
      res.status(400).json({ error: "Invalid activity pagination. Limit must be 1–50 and cursor must be a valid event ID." });
      return;
    }

    const workspaceId = String(req.params.workspaceId);
    const complaint = await pool.query("SELECT id FROM complaints WHERE id = $1 AND workspace_id = $2", [complaintId, workspaceId]);
    if (!complaint.rows[0]) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }

    if (rawCursor) {
      const cursor = await pool.query(
        `SELECT id FROM complaint_activity_events
         WHERE id = $1 AND complaint_id = $2 AND workspace_id = $3`,
        [rawCursor, complaintId, workspaceId]
      );
      if (!cursor.rows[0]) {
        res.status(400).json({ error: "Invalid activity pagination cursor." });
        return;
      }
    }

    const result = await pool.query<{
      id: string; event_type: string; actor_user_id: string; actor_name: string | null;
      occurred_at: Date; metadata: Record<string, unknown>; social_message: string | null;
    }>(
      `SELECT e.id, e.event_type, e.actor_user_id, u.name AS actor_name, e.occurred_at, e.metadata,
              m.body AS social_message
       FROM complaint_activity_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
       LEFT JOIN meta_social_messages m ON m.activity_event_id = e.id AND m.workspace_id = e.workspace_id
       WHERE e.complaint_id = $1 AND e.workspace_id = $2
         AND ($3::uuid IS NULL OR (e.occurred_at, e.id) > (
           SELECT c.occurred_at, c.id FROM complaint_activity_events c
           WHERE c.id = $3 AND c.complaint_id = $1 AND c.workspace_id = $2
         ))
       ORDER BY e.occurred_at ASC, e.id ASC
       LIMIT $4`,
      [complaintId, workspaceId, rawCursor ?? null, limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const events = result.rows.slice(0, limit);
    res.json({ events, pagination: { limit, nextCursor: hasMore ? events[events.length - 1].id : null } });
  }));

  app.get("/workspaces/:workspaceId/complaints/:complaintId/analysis", requireAuth, requireWorkspaceRole(["owner", "admin", "member"]), asyncRoute(async (req, res) => {
    const complaintId = String(req.params.complaintId);
    if (!uuidPattern.test(complaintId)) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }
    const result = await pool.query<ComplaintAnalysis & { complaint_id: string; job_status: string | null; job_error: string | null }>(
      `SELECT ca.complaint_id, ca.category, ca.sentiment, ca.severity, ca.priority_score, ca.priority_label,
              ca.reasoning_summary, ca.suggested_reply, ca.model_name, ca.analyzed_at,
              j.status AS job_status, j.error_code AS job_error
       FROM complaints c
       LEFT JOIN complaint_analyses ca ON ca.complaint_id = c.id
       LEFT JOIN complaint_analysis_jobs j ON j.complaint_id = c.id
       WHERE c.id = $1 AND c.workspace_id = $2`,
      [complaintId, String(req.params.workspaceId)]
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }
    const { complaint_id: _complaintId, job_status, job_error, ...analysis } = result.rows[0];
    res.json({
      analysis: _complaintId ? analysis : null,
      job: {
        status: job_status ?? (_complaintId ? "completed" : "pending"),
        error: job_error ?? null
      }
    });
  }));

  app.post("/workspaces/:workspaceId/complaints/:complaintId/analysis", requireAuth, csrfProtection, requireWorkspaceRole(["owner", "admin", "member"]), asyncRoute(async (req, res) => {
    const complaintId = String(req.params.complaintId);
    if (!uuidPattern.test(complaintId)) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }
    if (Object.keys(req.body ?? {}).length !== 0) {
      res.status(400).json({ error: "Invalid analysis request." });
      return;
    }
    const complaintResult = await pool.query<Pick<ComplaintRow, "id" | "title" | "description">>(
      "SELECT id, title, description FROM complaints WHERE id = $1 AND workspace_id = $2",
      [complaintId, String(req.params.workspaceId)]
    );
    const complaint = complaintResult.rows[0];
    if (!complaint) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }

    if (activeAnalysisRequests.has(complaintId)) {
      res.status(409).json({ error: "Analysis is already in progress for this complaint." });
      return;
    }
    activeAnalysisRequests.add(complaintId);
    try {
      const configuredTimeout = Number(process.env.AI_SERVICE_TIMEOUT_MS ?? 45000);
      const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout >= 100 && configuredTimeout <= 60000 ? configuredTimeout : 45000;
      const serviceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8001";
      let analysis: unknown;
      let failureCode = "processing_failed";
      try {
        const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: complaint.title, description: complaint.description }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        const responseBody = await response.text();
        if (responseBody.length > 16000) {
          await pool.query(
            `UPDATE complaint_analysis_jobs SET status = 'failed', error_code = 'oversized_response', locked_until = NULL, updated_at = now() WHERE complaint_id = $1`,
            [complaintId]
          );
          res.status(502).json({ error: "Analysis service returned an invalid response." });
          return;
        }
        let servicePayload: unknown;
        try { servicePayload = JSON.parse(responseBody); } catch {
          await pool.query(
            `UPDATE complaint_analysis_jobs SET status = 'failed', error_code = 'invalid_json', locked_until = NULL, updated_at = now() WHERE complaint_id = $1`,
            [complaintId]
          );
          res.status(502).json({ error: "Analysis service returned an invalid response." });
          return;
        }
        if (!response.ok) {
          const detail = servicePayload && typeof servicePayload === "object" && "detail" in servicePayload ? servicePayload.detail : undefined;
          if (response.status === 503 && detail === "AI analysis is not configured on the server.") {
            failureCode = "not_configured";
            await pool.query(
              `UPDATE complaint_analysis_jobs SET status = 'failed', error_code = $2, locked_until = NULL, updated_at = now() WHERE complaint_id = $1`,
              [complaintId, failureCode]
            );
            res.status(503).json({ error: "AI analysis is not configured. Set the selected provider's API key for the AI service." });
          } else if (response.status === 504) {
            failureCode = "timeout";
            await pool.query(
              `UPDATE complaint_analysis_jobs SET status = 'failed', error_code = $2, locked_until = NULL, updated_at = now() WHERE complaint_id = $1`,
              [complaintId, failureCode]
            );
            res.status(504).json({ error: "Analysis timed out. You can retry manually." });
          } else {
            failureCode = "service_unavailable";
            await pool.query(
              `UPDATE complaint_analysis_jobs SET status = 'failed', error_code = $2, locked_until = NULL, updated_at = now() WHERE complaint_id = $1`,
              [complaintId, failureCode]
            );
            res.status(502).json({ error: "Analysis service unavailable. You can retry analysis manually." });
          }
          return;
        }
        analysis = servicePayload;
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        failureCode = timedOut ? "timeout" : "service_unavailable";
        await pool.query(
          `UPDATE complaint_analysis_jobs SET status = 'failed', error_code = $2, locked_until = NULL, updated_at = now() WHERE complaint_id = $1`,
          [complaintId, failureCode]
        );
        res.status(timedOut ? 504 : 502).json({ error: timedOut ? "Analysis timed out. You can retry manually." : "Analysis service unavailable. You can retry manually." });
        return;
      }
      if (!validComplaintAnalysis(analysis)) {
        await pool.query(
          `UPDATE complaint_analysis_jobs SET status = 'failed', error_code = 'schema_validation_failed', locked_until = NULL, updated_at = now() WHERE complaint_id = $1`,
          [complaintId]
        );
        res.status(502).json({ error: "Analysis service returned an invalid response." });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const saved = await client.query<ComplaintAnalysis>(
          `INSERT INTO complaint_analyses
             (complaint_id, category, sentiment, severity, priority_score, priority_label, reasoning_summary, suggested_reply, model_name, analyzed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (complaint_id) DO UPDATE SET
             category = EXCLUDED.category, sentiment = EXCLUDED.sentiment, severity = EXCLUDED.severity,
             priority_score = EXCLUDED.priority_score, priority_label = EXCLUDED.priority_label,
             reasoning_summary = EXCLUDED.reasoning_summary, suggested_reply = EXCLUDED.suggested_reply,
             model_name = EXCLUDED.model_name, analyzed_at = EXCLUDED.analyzed_at, updated_at = now()
           RETURNING category, sentiment, severity, priority_score, priority_label, reasoning_summary, suggested_reply, model_name, analyzed_at`,
          [complaintId, analysis.category, analysis.sentiment, analysis.severity, analysis.priority_score, analysis.priority_label,
            analysis.reasoning_summary, analysis.suggested_reply, analysis.model_name, analysis.analyzed_at]
        );
        await client.query(
          `INSERT INTO complaint_analysis_jobs(complaint_id, workspace_id, status, attempt_count, locked_until, error_code)
           VALUES($1, $2, 'completed', 1, NULL, NULL)
           ON CONFLICT(complaint_id) DO UPDATE SET status='completed', locked_until=NULL, error_code=NULL, updated_at=now()`,
          [complaintId, String(req.params.workspaceId)]
        );
        const user = res.locals.user as UserRow;
        const activity = await client.query<{ id: string }>(
          `INSERT INTO complaint_activity_events (complaint_id, workspace_id, event_type, actor_user_id, metadata)
           VALUES ($1, $2, 'analysis_completed', $3, '{}'::jsonb) RETURNING id`,
          [complaintId, String(req.params.workspaceId), user.id]
        );
        await enqueueWebhookDeliveries(client, activity.rows[0].id, String(req.params.workspaceId));
        await client.query("COMMIT");
        res.json({ analysis: saved.rows[0], job: { status: "completed", error: null } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } finally {
      activeAnalysisRequests.delete(complaintId);
    }
  }));

  app.patch("/workspaces/:workspaceId/complaints/:complaintId/status", requireAuth, csrfProtection, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const complaintId = String(req.params.complaintId);
    const { status } = req.body ?? {};
    if (!uuidPattern.test(complaintId)) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }
    if (Object.keys(req.body ?? {}).length !== 1 || !complaintStatuses.includes(status)) {
      res.status(400).json({ error: "Status must be one of: open, in_progress, resolved, closed." });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<Pick<ComplaintRow, "status">>(
        "SELECT status FROM complaints WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [complaintId, String(req.params.workspaceId)]
      );
      if (!current.rows[0]) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Complaint not found" });
        return;
      }
      const result = await client.query<ComplaintRow>(
        `UPDATE complaints SET status = $1, updated_at = now()
         WHERE id = $2 AND workspace_id = $3
         RETURNING id, workspace_id, title, description, customer_name, customer_email, submitted_category, source, status, created_by, created_at, updated_at`,
        [status, complaintId, String(req.params.workspaceId)]
      );
      if (current.rows[0].status !== status) {
        const user = res.locals.user as UserRow;
        const activity = await client.query<{ id: string }>(
          `INSERT INTO complaint_activity_events (complaint_id, workspace_id, event_type, actor_user_id, metadata)
           VALUES ($1, $2, 'status_changed', $3, $4::jsonb) RETURNING id`,
          [complaintId, String(req.params.workspaceId), user.id, JSON.stringify({ previous_status: current.rows[0].status, new_status: status })]
        );
        await enqueueWebhookDeliveries(client, activity.rows[0].id, String(req.params.workspaceId));
      }
      await client.query("COMMIT");
      res.json({ complaint: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Request failed", error);
    res.status(500).json({ error: "An internal error occurred." });
  });

  return app;
}
