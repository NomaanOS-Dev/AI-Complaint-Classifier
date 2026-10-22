import { randomBytes } from "node:crypto";
import type { Application, Request, RequestHandler, Response } from "express";
import { decryptWebhookSecret, encryptWebhookSecret } from "./integration-security.js";
import { generateOpaqueRoutingToken, hashClientAddress, sha256 } from "./day8-ingestion.js";
import { pool } from "./db.js";

type Middleware = RequestHandler;
type RouteOptions = {
  requireAuth: Middleware;
  csrfProtection: Middleware;
  requireWorkspaceRole: (roles: Array<"owner" | "admin" | "member">) => Middleware;
  enqueueWebhookDeliveries: (client: import("pg").PoolClient, eventId: string, workspaceId: string) => Promise<void>;
};

const categories = ["payment", "refund", "delivery", "account", "technical", "product_quality", "other"];
const genericPublicError = { error: "This form is unavailable. Check the link or try again later." };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const formFields = ["name", "email", "subject", "description", "category"] as const;
type FormField = typeof formFields[number];
type PublicFormFieldConfig = Record<FormField, { enabled: boolean; required: boolean }>;
const defaultFormFields: PublicFormFieldConfig = {
  name: { enabled: true, required: true }, email: { enabled: true, required: true },
  subject: { enabled: true, required: true }, description: { enabled: true, required: true },
  category: { enabled: true, required: false }
};

function parseEmbedFormInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["displayName", "fields", "allowedOrigins"].includes(key)) ||
      typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.trim().length > 100 ||
      !input.fields || typeof input.fields !== "object" || Array.isArray(input.fields) || !Array.isArray(input.allowedOrigins) || input.allowedOrigins.length < 1 || input.allowedOrigins.length > 10) return null;
  const rawFields = input.fields as Record<string, unknown>;
  if (Object.keys(rawFields).some((key) => !formFields.includes(key as FormField)) ||
      formFields.some((key) => !rawFields[key] || typeof rawFields[key] !== "object" || Array.isArray(rawFields[key]))) return null;
  const fields = {} as PublicFormFieldConfig;
  for (const key of formFields) {
    const item = rawFields[key] as Record<string, unknown>;
    if (typeof item.enabled !== "boolean" || typeof item.required !== "boolean" || (item.required && !item.enabled)) return null;
    fields[key] = { enabled: item.enabled, required: item.required };
  }
  if (!fields.subject.enabled || !fields.subject.required || !fields.description.enabled || !fields.description.required) return null;
  const origins: string[] = [];
  for (const item of input.allowedOrigins) {
    if (typeof item !== "string" || item.length > 255) return null;
    let url: URL;
    try { url = new URL(item.trim()); } catch { return null; }
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((!localHttp && url.protocol !== "https:") || url.origin !== item.trim() || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    origins.push(url.origin);
  }
  if (new Set(origins).size !== origins.length) return null;
  return { displayName: input.displayName.trim(), fields, allowedOrigins: origins };
}

function originAddress(workspaceId: string) {
  const domain = process.env.RESEND_INBOUND_DOMAIN?.trim().toLowerCase();
  if (!domain || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
  // Email addresses are canonicalized to lowercase by normalizeRecipient; use a
  // lowercase-only token so provider normalization cannot change its hash.
  const token = randomBytes(32).toString("hex");
  return { token, address: `nomaan-${token}@${domain}`, workspaceId };
}

function checkPublicBody(req: Request, res: Response) {
  const length = Number(req.get("content-length") ?? 0);
  if (length > 12_000 || Buffer.byteLength(JSON.stringify(req.body ?? {})) > 12_000) {
    res.status(413).json({ error: "Submission is too large." }); return false;
  }
  return true;
}

function normalizedContactBody(body: unknown, configuredFields: PublicFormFieldConfig) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "website" && (!formFields.includes(key as FormField) || !configuredFields[key as FormField].enabled))) return null;
  if (formFields.some((key) => configuredFields[key].enabled && configuredFields[key].required &&
      (typeof value[key] !== "string" || !value[key].trim()))) return null;
  if (formFields.some((key) => configuredFields[key].enabled && value[key] !== undefined && typeof value[key] !== "string")) return null;
  const nameRaw = typeof value.name === "string" ? value.name.trim().replace(/\s+/g, " ") : "";
  const emailRaw = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const name = nameRaw || null;
  const email = emailRaw || null;
  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const category = value.category === undefined || value.category === "" ? null : value.category;
  if ((name !== null && (name.length > 100 || /[\r\n\0]/.test(name))) || (email !== null && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) ||
      !subject || subject.length > 200 || !description || description.length > 10_000 ||
      (category !== null && (typeof category !== "string" || !categories.includes(category))) ||
      (configuredFields.category.enabled && value.category !== undefined && typeof value.category !== "string") ||
      (value.website !== undefined && (typeof value.website !== "string" || value.website.length > 500))) return null;
  return { name, email, subject, description, category: category as string | null, website: typeof value.website === "string" ? value.website.trim() : "" };
}

async function consumeContactLimit(client: import("pg").PoolClient, formId: string, workspaceId: string, clientHash: Buffer) {
  const perClient = await client.query<{ request_count: number; retry_after: number }>(
    `INSERT INTO public_contact_rate_limits(form_id, client_hash, window_started_at, request_count)
     SELECT $1, $2, date_bin('15 minutes', clock_timestamp(), timestamptz '2000-01-01'), 1
     ON CONFLICT (form_id, client_hash) DO UPDATE SET
       request_count = CASE WHEN public_contact_rate_limits.window_started_at < EXCLUDED.window_started_at THEN 1 ELSE public_contact_rate_limits.request_count + 1 END,
       window_started_at = greatest(public_contact_rate_limits.window_started_at, EXCLUDED.window_started_at), updated_at = now()
     RETURNING request_count, greatest(1, ceil(extract(epoch FROM (window_started_at + interval '15 minutes' - clock_timestamp())))::int) retry_after`,
    [formId, clientHash]
  );
  const workspace = await client.query<{ request_count: number; retry_after: number }>(
    `INSERT INTO workspace_contact_rate_limits(workspace_id, window_started_at, request_count)
     SELECT $1, date_bin('15 minutes', clock_timestamp(), timestamptz '2000-01-01'), 1
     ON CONFLICT (workspace_id) DO UPDATE SET
       request_count = CASE WHEN workspace_contact_rate_limits.window_started_at < EXCLUDED.window_started_at THEN 1 ELSE workspace_contact_rate_limits.request_count + 1 END,
       window_started_at = greatest(workspace_contact_rate_limits.window_started_at, EXCLUDED.window_started_at), updated_at = now()
     RETURNING request_count, greatest(1, ceil(extract(epoch FROM (window_started_at + interval '15 minutes' - clock_timestamp())))::int) retry_after`,
    [workspaceId]
  );
  return { blocked: perClient.rows[0].request_count > 8 || workspace.rows[0].request_count > 200,
    retryAfter: Math.max(perClient.rows[0].retry_after, workspace.rows[0].retry_after) };
}

export function mountDay8Routes(app: Application, options: RouteOptions) {
  const auth = options.requireAuth;
  const csrf = options.csrfProtection;
  const owner = options.requireWorkspaceRole(["owner", "admin"]);

  app.get("/workspaces/:workspaceId/integrations/embed-forms", auth, owner, async (req, res) => {
    const result = await pool.query(
      `SELECT id, display_name, fields, allowed_origins, enabled, created_at, updated_at, revoked_at
       FROM public_contact_forms WHERE workspace_id = $1 AND form_type = 'embed' ORDER BY created_at DESC, id DESC`,
      [String(req.params.workspaceId)]
    );
    res.json({ forms: result.rows, hostedFormBaseUrl: process.env.PUBLIC_FORM_BASE_URL ?? "http://localhost:3000/contact" });
  });

  app.post("/workspaces/:workspaceId/integrations/embed-forms", csrf, auth, owner, async (req, res) => {
    const input = parseEmbedFormInput(req.body);
    if (!input) { res.status(400).json({ error: "Provide a form name, supported field settings, and 1–10 valid HTTPS website origins. Subject and description must remain required." }); return; }
    const user = res.locals.user as { id: string };
    const token = generateOpaqueRoutingToken();
    const result = await pool.query(
      `INSERT INTO public_contact_forms(workspace_id, form_type, display_name, fields, allowed_origins, form_token_hash, created_by)
       VALUES($1, 'embed', $2, $3::jsonb, $4, $5, $6)
       RETURNING id, display_name, fields, allowed_origins, enabled, created_at, updated_at, revoked_at`,
      [String(req.params.workspaceId), input.displayName, JSON.stringify(input.fields), input.allowedOrigins, sha256(token), user.id]
    );
    const base = process.env.PUBLIC_FORM_BASE_URL ?? "http://localhost:3000/contact";
    res.status(201).json({ form: result.rows[0], token, formUrl: `${base.replace(/\/$/, "")}/${token}` });
  });

  app.patch("/workspaces/:workspaceId/integrations/embed-forms/:formId", csrf, auth, owner, async (req, res) => {
    if (!uuidPattern.test(String(req.params.formId))) { res.status(404).json({ error: "Embed form not found." }); return; }
    const input = parseEmbedFormInput(req.body);
    if (!input) { res.status(400).json({ error: "Provide a form name, supported field settings, and 1–10 valid HTTPS website origins. Subject and description must remain required." }); return; }
    const result = await pool.query(
      `UPDATE public_contact_forms SET display_name=$3, fields=$4::jsonb, allowed_origins=$5, updated_at=now()
       WHERE id=$1 AND workspace_id=$2 AND form_type='embed' AND revoked_at IS NULL
       RETURNING id, display_name, fields, allowed_origins, enabled, created_at, updated_at, revoked_at`,
      [String(req.params.formId), String(req.params.workspaceId), input.displayName, JSON.stringify(input.fields), input.allowedOrigins]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Embed form not found." }); return; }
    res.json({ form: result.rows[0] });
  });

  app.post("/workspaces/:workspaceId/integrations/embed-forms/:formId/rotate", csrf, auth, owner, async (req, res) => {
    if (!uuidPattern.test(String(req.params.formId))) { res.status(404).json({ error: "Embed form not found." }); return; }
    if (Object.keys(req.body ?? {}).length) { res.status(400).json({ error: "Rotation accepts an empty JSON object." }); return; }
    const token = generateOpaqueRoutingToken();
    const result = await pool.query(
      `UPDATE public_contact_forms SET form_token_hash=$3, enabled=true, revoked_at=NULL, updated_at=now()
       WHERE id=$1 AND workspace_id=$2 AND form_type='embed'
       RETURNING id, display_name, fields, allowed_origins, enabled, created_at, updated_at, revoked_at`,
      [String(req.params.formId), String(req.params.workspaceId), sha256(token)]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Embed form not found." }); return; }
    const base = process.env.PUBLIC_FORM_BASE_URL ?? "http://localhost:3000/contact";
    res.json({ form: result.rows[0], token, formUrl: `${base.replace(/\/$/, "")}/${token}` });
  });

  app.post("/workspaces/:workspaceId/integrations/embed-forms/:formId/revoke", csrf, auth, owner, async (req, res) => {
    if (!uuidPattern.test(String(req.params.formId))) { res.status(404).json({ error: "Embed form not found." }); return; }
    if (Object.keys(req.body ?? {}).length) { res.status(400).json({ error: "Revocation accepts an empty JSON object." }); return; }
    const result = await pool.query(
      `UPDATE public_contact_forms SET enabled=false, revoked_at=now(), updated_at=now()
       WHERE id=$1 AND workspace_id=$2 AND form_type='embed' AND revoked_at IS NULL RETURNING id`,
      [String(req.params.formId), String(req.params.workspaceId)]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Embed form not found." }); return; }
    res.status(204).end();
  });

  app.get("/workspaces/:workspaceId/integrations/contact-form", auth, owner, async (req, res) => {
    const result = await pool.query<{ id: string; enabled: boolean; created_at: Date; updated_at: Date; revoked_at: Date | null }>(
      `SELECT id, enabled, created_at, updated_at, revoked_at FROM public_contact_forms WHERE workspace_id = $1 AND form_type = 'hosted'`, [String(req.params.workspaceId)]
    );
    res.json({ form: result.rows[0] ?? null, hostedFormBaseUrl: process.env.PUBLIC_FORM_BASE_URL ?? "http://localhost:3000/contact" });
  });

  app.post("/workspaces/:workspaceId/integrations/contact-form", csrf, auth, owner, async (req, res) => {
    if (Object.keys(req.body ?? {}).length > 0) { res.status(400).json({ error: "Contact form creation accepts an empty JSON object." }); return; }
    const user = res.locals.user as { id: string };
    const prior = await pool.query<{ id: string; revoked_at: Date | null }>(
      "SELECT id, revoked_at FROM public_contact_forms WHERE workspace_id = $1 AND form_type = 'hosted'", [String(req.params.workspaceId)]
    );
    if (prior.rows[0] && !prior.rows[0].revoked_at) { res.status(409).json({ error: "A contact form already exists. Rotate or update it instead." }); return; }
    const token = generateOpaqueRoutingToken();
    const result = await pool.query(
      `INSERT INTO public_contact_forms(workspace_id, form_token_hash, created_by, enabled, revoked_at)
       VALUES ($1, $2, $3, true, NULL)
       ON CONFLICT(workspace_id) WHERE form_type = 'hosted' DO UPDATE SET form_token_hash = EXCLUDED.form_token_hash,
         enabled = true, revoked_at = NULL, updated_at = now()
       RETURNING id, enabled, created_at, updated_at, revoked_at`,
      [String(req.params.workspaceId), sha256(token), user.id]
    );
    res.status(201).json({ form: result.rows[0], token, warning: "Copy the public form token now. It is stored as a hash and cannot be shown again." });
  });

  app.post("/workspaces/:workspaceId/integrations/contact-form/rotate", csrf, auth, owner, async (req, res) => {
    const token = generateOpaqueRoutingToken();
    const result = await pool.query(
      `UPDATE public_contact_forms SET form_token_hash = $2, enabled = true, revoked_at = NULL, updated_at = now()
       WHERE workspace_id = $1 AND form_type = 'hosted' RETURNING id, enabled, created_at, updated_at, revoked_at`,
      [String(req.params.workspaceId), sha256(token)]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Contact form not found." }); return; }
    res.json({ form: result.rows[0], token, warning: "The old form token is invalid immediately. Copy this token now." });
  });

  app.patch("/workspaces/:workspaceId/integrations/contact-form", csrf, auth, owner, async (req, res) => {
    if (Object.keys(req.body ?? {}).length !== 1 || typeof req.body?.enabled !== "boolean") { res.status(400).json({ error: "Provide enabled as a boolean." }); return; }
    const result = await pool.query(
      `UPDATE public_contact_forms SET enabled = $2, revoked_at = CASE WHEN $2 THEN NULL ELSE now() END, updated_at = now()
       WHERE workspace_id = $1 AND form_type = 'hosted' RETURNING id, enabled, created_at, updated_at, revoked_at`, [String(req.params.workspaceId), req.body.enabled]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Contact form not found." }); return; }
    res.json({ form: result.rows[0] });
  });

  app.get("/workspaces/:workspaceId/integrations/inbound-email", auth, owner, async (req, res) => {
    const result = await pool.query<{ id: string; recipient_ciphertext: string; enabled: boolean; created_at: Date; updated_at: Date; revoked_at: Date | null }>(
      `SELECT id, recipient_ciphertext, enabled, created_at, updated_at, revoked_at FROM workspace_inbound_email_routes WHERE workspace_id = $1`, [String(req.params.workspaceId)]
    );
    let inboundAddress: string | null = null;
    let encryptionError = false;
    if (result.rows[0]) {
      try { inboundAddress = decryptWebhookSecret(result.rows[0].recipient_ciphertext); } catch { encryptionError = true; }
    }
    const domainConfigured = Boolean(process.env.RESEND_INBOUND_DOMAIN);
    const providerSecretsConfigured = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_WEBHOOK_SECRET);
    const status = !domainConfigured || !result.rows[0] ? "not_configured" : encryptionError || !providerSecretsConfigured ? "error" :
      result.rows[0].revoked_at || !result.rows[0].enabled ? "disabled" : "awaiting_provider_setup";
    res.json({ route: result.rows[0] ? { id: result.rows[0].id, inboundAddress, enabled: result.rows[0].enabled,
      created_at: result.rows[0].created_at, updated_at: result.rows[0].updated_at, revoked_at: result.rows[0].revoked_at } : null,
      status });
  });

  app.post("/workspaces/:workspaceId/integrations/inbound-email", csrf, auth, owner, async (req, res) => {
    if (Object.keys(req.body ?? {}).some((key) => key !== "enabled") ||
        (req.body?.enabled !== undefined && typeof req.body.enabled !== "boolean")) {
      res.status(400).json({ error: "Only an optional enabled boolean is accepted." }); return;
    }
    try {
      const configured = originAddress(String(req.params.workspaceId));
      if (!configured) { res.status(503).json({ error: "RESEND_INBOUND_DOMAIN is not configured on the API." }); return; }
      if (!process.env.INTEGRATION_ENCRYPTION_KEY) { res.status(503).json({ error: "Inbound address encryption is not configured on the API." }); return; }
      const user = res.locals.user as { id: string };
      const result = await pool.query(
        `INSERT INTO workspace_inbound_email_routes(workspace_id, routing_token_hash, recipient_hash, recipient_ciphertext, created_by, enabled)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(workspace_id) DO UPDATE SET routing_token_hash = EXCLUDED.routing_token_hash,
           recipient_hash = EXCLUDED.recipient_hash, recipient_ciphertext = EXCLUDED.recipient_ciphertext,
           enabled = EXCLUDED.enabled, revoked_at = NULL, updated_at = now()
         RETURNING id, enabled, created_at, updated_at`,
        [String(req.params.workspaceId), sha256(configured.token), sha256(configured.address), encryptWebhookSecret(configured.address), user.id, req.body.enabled ?? true]
      );
      res.status(201).json({ route: { ...result.rows[0], inboundAddress: configured.address }, status: result.rows[0].enabled ? "awaiting_provider_setup" : "disabled",
        warning: "This address is routed locally but Resend account webhook setup and a real delivery have not been verified." });
    } catch { res.status(503).json({ error: "Inbound routing could not be configured securely." }); }
  });

  app.post("/workspaces/:workspaceId/integrations/inbound-email/rotate", csrf, auth, owner, async (req, res) => {
    const configured = originAddress(String(req.params.workspaceId));
    if (!configured) { res.status(503).json({ error: "RESEND_INBOUND_DOMAIN is not configured on the API." }); return; }
    if (!process.env.INTEGRATION_ENCRYPTION_KEY) { res.status(503).json({ error: "Inbound address encryption is not configured on the API." }); return; }
    const result = await pool.query(
      `UPDATE workspace_inbound_email_routes SET routing_token_hash = $3, recipient_hash = $4, recipient_ciphertext = $5,
         enabled = true, revoked_at = NULL, updated_at = now()
       WHERE workspace_id = $1 RETURNING id, enabled, created_at, updated_at`,
      [String(req.params.workspaceId), sha256(configured.token), sha256(configured.address), encryptWebhookSecret(configured.address)]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Inbound route not found." }); return; }
    res.json({ route: { ...result.rows[0], inboundAddress: configured.address }, status: "awaiting_provider_setup" });
  });

  app.patch("/workspaces/:workspaceId/integrations/inbound-email", csrf, auth, owner, async (req, res) => {
    if (Object.keys(req.body ?? {}).length !== 1 || typeof req.body?.enabled !== "boolean") { res.status(400).json({ error: "Provide enabled as a boolean." }); return; }
    const result = await pool.query(
      `UPDATE workspace_inbound_email_routes SET enabled = $2, revoked_at = CASE WHEN $2 THEN NULL ELSE now() END, updated_at = now()
       WHERE workspace_id = $1 RETURNING id, enabled, updated_at, revoked_at`, [String(req.params.workspaceId), req.body.enabled]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Inbound route not found." }); return; }
    res.json({ route: result.rows[0], status: req.body.enabled ? "awaiting_provider_setup" : "disabled" });
  });

  app.get("/workspaces/:workspaceId/integrations/inbound-email/events", auth, owner, async (req, res) => {
    const limit = Number(req.query.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) { res.status(400).json({ error: "limit must be between 1 and 50." }); return; }
    const result = await pool.query(
      `SELECT status, error_code, attempt_count, next_attempt_at, received_at, processed_at, attachment_metadata
       FROM resend_inbound_events WHERE workspace_id = $1 ORDER BY received_at DESC, id DESC LIMIT $2`,
      [String(req.params.workspaceId), limit]
    );
    res.json({ events: result.rows });
  });

  app.get("/public/contact/:token", async (req, res) => {
    const token = String(req.params.token);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { res.status(404).json(genericPublicError); return; }
    const result = await pool.query<{ display_name: string; fields: PublicFormFieldConfig; allowed_origins: string[] }>(
      "SELECT display_name,fields,allowed_origins FROM public_contact_forms WHERE form_token_hash = $1 AND enabled AND revoked_at IS NULL", [sha256(token)]
    );
    if (!result.rows[0]) { res.status(404).json(genericPublicError); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.json({ form: { active: true, displayName: result.rows[0].display_name, fields: result.rows[0].fields, allowedOrigins: result.rows[0].allowed_origins } });
  });

  app.post("/public/contact/:token", async (req, res) => {
    if (!checkPublicBody(req, res)) return;
    const token = String(req.params.token);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { res.status(404).json(genericPublicError); return; }
    const formResult = await pool.query<{ id: string; workspace_id: string; created_by: string; fields: PublicFormFieldConfig }>(
      "SELECT f.id, f.workspace_id, f.created_by, f.fields FROM public_contact_forms f WHERE f.form_token_hash = $1 AND f.enabled AND f.revoked_at IS NULL",
      [sha256(token)]
    );
    const form = formResult.rows[0];
    if (!form) { res.status(404).json(genericPublicError); return; }
    const contact = normalizedContactBody(req.body, form.fields);
    if (!contact) { res.status(400).json({ error: "Enter valid values for the configured form fields." }); return; }
    if (!/^[\x21-\x7e]{1,128}$/.test(req.get("idempotency-key") ?? "")) { res.status(400).json({ error: "A valid Idempotency-Key header is required." }); return; }
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const clientHash = hashClientAddress(clientIp);
    const normalized = { name: contact.name, email: contact.email, subject: contact.subject, description: contact.description, category: contact.category };
    const payloadHash = sha256(JSON.stringify(normalized));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const limit = await consumeContactLimit(client, form.id, form.workspace_id, clientHash);
      if (limit.blocked) {
        await client.query("COMMIT"); res.setHeader("Retry-After", String(limit.retryAfter));
        res.status(429).json({ error: "Please wait before submitting another message." }); return;
      }
      if (contact.website) { await client.query("COMMIT"); res.status(202).json({ status: "accepted" }); return; }
      const key = req.get("idempotency-key")!;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${form.id}:${key}`]);
      await client.query("DELETE FROM public_contact_idempotency WHERE form_id = $1 AND idempotency_key = $2 AND expires_at <= now()", [form.id, key]);
      const prior = await client.query<{ payload_hash: Buffer; response_body: unknown }>(
        "SELECT payload_hash, response_body FROM public_contact_idempotency WHERE form_id = $1 AND idempotency_key = $2 FOR UPDATE", [form.id, key]
      );
      if (prior.rows[0]) {
        if (!Buffer.from(prior.rows[0].payload_hash).equals(payloadHash)) {
          await client.query("ROLLBACK"); res.status(409).json({ error: "This request key was already used for a different submission." }); return;
        }
        await client.query("COMMIT"); res.setHeader("Idempotent-Replayed", "true"); res.status(200).json(prior.rows[0].response_body); return;
      }
      const complaint = await client.query<{ id: string }>(
        `INSERT INTO complaints(workspace_id, title, description, customer_name, customer_email, submitted_category, source, created_by)
         VALUES($1,$2,$3,$4,$5,$6,'contact_form',$7) RETURNING id`,
        [form.workspace_id, contact.subject, contact.description, contact.name, contact.email, contact.category, form.created_by]
      );
      const activity = await client.query<{ id: string }>(
        `INSERT INTO complaint_activity_events(complaint_id, workspace_id, event_type, actor_user_id, metadata)
         VALUES($1,$2,'complaint_created',$3,'{"source":"public_contact_form"}'::jsonb) RETURNING id`,
        [complaint.rows[0].id, form.workspace_id, form.created_by]
      );
      await options.enqueueWebhookDeliveries(client, activity.rows[0].id, form.workspace_id);
      const responseBody = { status: "accepted", reference: randomBytes(9).toString("hex") };
      await client.query(
        `INSERT INTO public_contact_idempotency(form_id,workspace_id,idempotency_key,payload_hash,complaint_id,response_body,expires_at)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,now()+interval '7 days')`,
        [form.id, form.workspace_id, key, payloadHash, complaint.rows[0].id, JSON.stringify(responseBody)]
      );
      await client.query("COMMIT");
      res.status(201).json(responseBody);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });
}
