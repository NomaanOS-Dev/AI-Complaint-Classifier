import { Resend } from "resend";
import type { Application, Request, Response } from "express";
import express from "express";
import { pool } from "./db.js";
import { normalizeRecipient, sha256 } from "./day8-ingestion.js";

function validId(value: unknown) { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value); }

async function handleResendEvent(req: Request, res: Response) {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!webhookSecret) { res.status(503).json({ error: "Resend webhook verification is not configured." }); return; }
  if (!process.env.RESEND_API_KEY) { res.status(503).json({ error: "Resend email retrieval is not configured." }); return; }
  if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: "Invalid webhook body." }); return; }
  const raw = req.body.toString("utf8");
  const svixId = req.get("svix-id"); const timestamp = req.get("svix-timestamp"); const signature = req.get("svix-signature");
  if (!svixId || !timestamp || !signature || svixId.length > 200 || timestamp.length > 40 || signature.length > 2000) {
    res.status(400).json({ error: "Missing or malformed webhook signature headers." }); return;
  }
  let event: unknown;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    event = resend.webhooks.verify({ payload: raw, headers: { id: svixId, timestamp, signature }, webhookSecret });
  } catch {
    res.status(400).json({ error: "Webhook signature verification failed." }); return;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) { res.status(400).json({ error: "Malformed webhook event." }); return; }
  const payload = event as Record<string, unknown>;
  if (payload.type !== "email.received" || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    res.status(400).json({ error: "Unsupported webhook event." }); return;
  }
  const data = payload.data as Record<string, unknown>;
  if (!validId(svixId) || !validId(data.email_id) || !Array.isArray(data.to) || data.to.length < 1 || data.to.length > 20 ||
      typeof data.from !== "string" || data.from.length > 512 || typeof data.subject !== "string" || data.subject.length > 1000 ||
      (data.message_id !== undefined && data.message_id !== null && !validId(data.message_id)) ||
      typeof data.created_at !== "string" || !Number.isFinite(Date.parse(data.created_at))) {
    res.status(400).json({ error: "Malformed received-email event." }); return;
  }
  const recipients = data.to.map(normalizeRecipient);
  if (recipients.some((recipient) => recipient === null)) { res.status(400).json({ error: "Malformed received-email recipient." }); return; }

  const matches = new Map<string, { id: string; workspace_id: string; recipient_hash: Buffer }>();
  for (const recipient of [...new Set(recipients as string[])]) {
    const hash = sha256(recipient);
    const result = await pool.query<{ id: string; workspace_id: string }>(
      `SELECT id, workspace_id FROM workspace_inbound_email_routes
       WHERE recipient_hash = $1 AND enabled = true AND revoked_at IS NULL`, [hash]
    );
    if (result.rows[0]) matches.set(result.rows[0].id, { ...result.rows[0], recipient_hash: hash });
  }
  const route = matches.size === 1 ? [...matches.values()][0] : null;
  const firstHash = sha256((recipients as string[])[0]);
  const status = route ? "received" : "rejected";
  const errorCode = route ? null : matches.size > 1 ? "ambiguous_recipient" : "unknown_recipient";
  try {
    const inserted = await pool.query(
      `INSERT INTO resend_inbound_events(provider_event_id, provider_email_id, provider_message_id, workspace_id,
         route_id, recipient_hash, status, error_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [svixId, data.email_id, data.message_id ?? null, route?.workspace_id ?? null, route?.id ?? null,
        route?.recipient_hash ?? firstHash, status, errorCode]
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(inserted.rowCount ? 202 : 200).json({ accepted: true, duplicate: !inserted.rowCount });
  } catch {
    // Resend must retry on temporary persistence failures; no message contents are logged.
    res.status(503).json({ error: "Webhook event could not be durably accepted." });
  }
}

export function mountResendWebhook(app: Application) {
  app.post("/webhooks/resend", express.raw({ type: "application/json", limit: "256kb" }), (req, res) => {
    void handleResendEvent(req, res).catch(() => {
      if (!res.headersSent) res.status(503).json({ error: "Webhook processing is temporarily unavailable." });
    });
  });
}
