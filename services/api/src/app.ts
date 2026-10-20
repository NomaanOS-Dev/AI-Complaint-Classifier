import argon2 from "argon2";
import connectPgSimple from "connect-pg-simple";
import cors from "cors";
import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import session from "express-session";
import { databaseIsReady, pool } from "./db.js";

const PgSessionStore = connectPgSimple(session);
const SESSION_COOKIE = "nomaanos.sid";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dummyPasswordHash = argon2.hash(randomBytes(32).toString("hex"), { type: argon2.argon2id });

type UserRow = { id: string; name: string; email: string };
type WorkspaceRow = { id: string; name: string; role?: "owner" | "admin" | "member"; created_at?: string };

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

export function createApp() {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || Buffer.byteLength(sessionSecret) < 32) {
    throw new Error("SESSION_SECRET must be configured with at least 32 bytes");
  }

  const app = express();
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
  app.use(cors({ origin, credentials: true }));
  app.use(express.json({ limit: "32kb" }));
  app.use(session({
    name: SESSION_COOKIE,
    secret: sessionSecret,
    store: new PgSessionStore({ pool, tableName: "user_sessions", createTableIfMissing: false }),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: isProduction, sameSite: "lax", maxAge: SESSION_MAX_AGE }
  }));

  app.get("/health", async (_req, res) => {
    try {
      await databaseIsReady();
      res.json({ status: "ok", service: "api", database: "ok" });
    } catch {
      res.status(503).json({ status: "error", service: "api", database: "unavailable" });
    }
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
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/" });
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

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Request failed", error);
    res.status(500).json({ error: "An internal error occurred." });
  });

  return app;
}
