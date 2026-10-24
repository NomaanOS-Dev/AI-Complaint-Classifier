import { createHmac, timingSafeEqual } from "node:crypto";
import type { Application, Request, RequestHandler, Response } from "express";
import express from "express";
import { pool } from "./db.js";
import { createWhatsAppGraphApi, revokeWhatsAppSubscription } from "./meta-whatsapp.js";
import { enqueueComplaintAnalysis } from "./complaint-analysis-worker.js";

type Provider = "whatsapp" | "instagram";
type SocialMessage = {
  provider: Provider;
  accountId: string;
  businessAccountId: string | null;
  senderId: string;
  senderName: string | null;
  externalMessageId: string;
  body: string;
  attachments: Array<Record<string, string>>;
  sentAt: Date | null;
};
type MetaRouteOptions = {
  requireAuth: RequestHandler;
  csrfProtection: RequestHandler;
  requireWorkspaceRole: (roles: Array<"owner" | "admin" | "member">) => RequestHandler;
  enqueueWebhookDeliveries: (client: import("pg").PoolClient, eventId: string, workspaceId: string) => Promise<void>;
  whatsappGraphApi?: import("./meta-whatsapp.js").WhatsAppGraphApi;
};

const maxWebhookBytes = 512 * 1024;
const mediaTypes = new Set(["image", "audio", "video", "document", "sticker"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyMetaSignature(rawBody: Buffer, supplied: string | undefined, appSecret: string) {
  if (!supplied || !/^sha256=[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return constantTimeEqual(expected.toLowerCase(), supplied.toLowerCase());
}

function parseProviderTimestamp(value: unknown, milliseconds: boolean): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const date = new Date(milliseconds ? number : number * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseWhatsAppEntry(entry: Record<string, unknown>): SocialMessage[] {
  if (!Array.isArray(entry.changes)) return [];
  const messages: SocialMessage[] = [];
  for (const change of entry.changes) {
    if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
    const value = change.value;
    const metadata = isRecord(value.metadata) ? value.metadata : {};
    const accountId = metadata.phone_number_id;
    if (!safeId(accountId) || !Array.isArray(value.messages)) continue;
    const businessAccountId = safeId(entry.id) ? entry.id : null;
    const contacts = Array.isArray(value.contacts) ? value.contacts.filter(isRecord) : [];
    for (const candidate of value.messages) {
      if (!isRecord(candidate) || !safeId(candidate.id) || !safeId(candidate.from, 40) ||
          !/^\d+$/.test(candidate.from) || !safeId(candidate.type, 40)) continue;
      const contact = contacts.find((item) => isRecord(item.profile) && item.wa_id === candidate.from);
      const profile = contact && isRecord(contact.profile) ? contact.profile : {};
      const senderName = typeof profile.name === "string" ? profile.name.trim().replace(/\s+/g, " ").slice(0, 100) || null : null;
      const text = candidate.type === "text" && isRecord(candidate.text) && typeof candidate.text.body === "string"
        ? candidate.text.body.trim() : "";
      const attachments: Array<Record<string, string>> = [];
      if (mediaTypes.has(candidate.type)) {
        const mediaValue = candidate[candidate.type];
        const media = isRecord(mediaValue) ? mediaValue : {};
        const attachment: Record<string, string> = { type: candidate.type };
        if (safeId(media.id)) attachment.providerMediaId = media.id;
        if (typeof media.mime_type === "string" && media.mime_type.length <= 100) attachment.mimeType = media.mime_type;
        if (typeof media.filename === "string") attachment.filename = media.filename.split(/[\\/]/).pop()!.replace(/[\r\n\0]/g, "").slice(0, 120);
        attachments.push(attachment);
      }
      const body = text || (attachments.length ? `Received ${candidate.type} message. Attachment content is not downloaded or stored.` : "");
      if (!body || body.length > 10000) continue;
      messages.push({
        provider: "whatsapp", accountId, businessAccountId, senderId: candidate.from, senderName,
        externalMessageId: candidate.id, body, attachments,
        sentAt: parseProviderTimestamp(candidate.timestamp, false)
      });
    }
  }
  return messages;
}

function parseInstagramEntry(entry: Record<string, unknown>): SocialMessage[] {
  if (!safeId(entry.id) || !Array.isArray(entry.messaging)) return [];
  const messages: SocialMessage[] = [];
  for (const event of entry.messaging) {
    if (!isRecord(event) || !isRecord(event.message) || !isRecord(event.sender) || !isRecord(event.recipient)) continue;
    const message = event.message;
    if (message.is_echo === true || message.is_self === true || message.is_deleted === true ||
        !safeId(message.mid) || !safeId(event.sender.id) || event.sender.id === entry.id ||
        event.recipient.id !== entry.id) continue;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const attachments: Array<Record<string, string>> = [];
    if (Array.isArray(message.attachments)) {
      for (const attachment of message.attachments.slice(0, 10)) {
        if (!isRecord(attachment) || typeof attachment.type !== "string" || !/^[a-z_]{1,40}$/.test(attachment.type)) continue;
        attachments.push({ type: attachment.type });
      }
    }
    const body = text || (attachments.length ? "Received an Instagram media message. Attachment content is not downloaded or stored." : "");
    if (!body || body.length > 10000) continue;
    messages.push({
      provider: "instagram", accountId: entry.id, businessAccountId: null,
      senderId: event.sender.id, senderName: null, externalMessageId: message.mid, body, attachments,
      sentAt: parseProviderTimestamp(event.timestamp, true)
    });
  }
  return messages;
}

export function parseMetaMessages(payload: unknown): SocialMessage[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) throw new Error("Malformed Meta webhook payload.");
  const provider: Provider | null = payload.object === "whatsapp_business_account" ? "whatsapp" :
    payload.object === "instagram" ? "instagram" : null;
  if (!provider) return [];
  const messages: SocialMessage[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry)) continue;
    messages.push(...(provider === "whatsapp" ? parseWhatsAppEntry(entry) : parseInstagramEntry(entry)));
  }
  return messages;
}

async function persistUnknownAccount(message: SocialMessage) {
  await pool.query(
    `INSERT INTO meta_social_events(provider, external_event_id, status, error_code)
     VALUES ($1, $2, 'rejected', 'unknown_account') ON CONFLICT (provider, external_event_id) DO NOTHING`,
    [message.provider, message.externalMessageId]
  );
}

async function persistSocialMessage(message: SocialMessage, enqueueWebhookDeliveries: MetaRouteOptions["enqueueWebhookDeliveries"]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const connectionResult = await client.query<{
      id: string; workspace_id: string; created_by: string; display_name: string; status: string; business_account_id: string | null;
    }>(
      `SELECT id, workspace_id, created_by, display_name, status, business_account_id
       FROM meta_social_connections
       WHERE provider = $1 AND provider_account_id = $2`,
      [message.provider, message.accountId]
    );
    const connection = connectionResult.rows[0];
    const mappingMismatch = Boolean(connection && message.provider === "whatsapp" &&
      connection.business_account_id && message.businessAccountId !== connection.business_account_id);
    if (!connection) {
      await client.query("ROLLBACK");
      await persistUnknownAccount(message);
      return "rejected" as const;
    }
    if (connection.status === "disconnected" || mappingMismatch) {
      const errorCode = connection.status === "disconnected" ? "connection_disconnected" : "unknown_account";
      await client.query(
        `INSERT INTO meta_social_events(provider, external_event_id, connection_id, workspace_id, status, error_code)
         VALUES ($1, $2, $3, $4, 'rejected', $5) ON CONFLICT (provider, external_event_id) DO NOTHING`,
        [message.provider, message.externalMessageId, connection.id, connection.workspace_id, errorCode]
      );
      await client.query(
        "UPDATE meta_social_connections SET last_error_code = $2, updated_at = now() WHERE id = $1",
        [connection.id, errorCode]
      );
      await client.query("COMMIT");
      return "rejected" as const;
    }

    const accepted = await client.query(
      `INSERT INTO meta_social_events(provider, external_event_id, connection_id, workspace_id, status, processed_at)
       VALUES ($1, $2, $3, $4, 'processed', now())
       ON CONFLICT (provider, external_event_id) DO NOTHING RETURNING id`,
      [message.provider, message.externalMessageId, connection.id, connection.workspace_id]
    );
    if (!accepted.rowCount) {
      await client.query("ROLLBACK");
      return "duplicate" as const;
    }

    const conversationKey = `sender:${message.senderId}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${connection.id}:${conversationKey}`]);
    let conversation = await client.query<{ id: string; complaint_id: string }>(
      `SELECT id, complaint_id FROM meta_social_conversations
       WHERE connection_id = $1 AND external_conversation_id = $2 FOR UPDATE`,
      [connection.id, conversationKey]
    );
    let complaintId: string;
    if (!conversation.rows[0]) {
      const titlePrefix = message.provider === "whatsapp" ? "WhatsApp" : "Instagram";
      const senderLabel = message.senderName ?? message.senderId;
      const complaint = await client.query<{ id: string }>(
        `INSERT INTO complaints (workspace_id, title, description, customer_name, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [connection.workspace_id, `${titlePrefix} message from ${senderLabel}`.slice(0, 200), message.body,
          message.senderName, message.provider, connection.created_by]
      );
      complaintId = complaint.rows[0].id;
      const createdActivity = await client.query<{ id: string }>(
        `INSERT INTO complaint_activity_events (complaint_id, workspace_id, event_type, actor_user_id, metadata)
         VALUES ($1, $2, 'complaint_created', $3, $4::jsonb) RETURNING id`,
        [complaintId, connection.workspace_id, connection.created_by, JSON.stringify({ source: message.provider })]
      );
      await enqueueWebhookDeliveries(client, createdActivity.rows[0].id, connection.workspace_id);
      await enqueueComplaintAnalysis(client, complaintId, connection.workspace_id);
      conversation = await client.query<{ id: string; complaint_id: string }>(
        `INSERT INTO meta_social_conversations
           (connection_id, workspace_id, external_conversation_id, external_sender_id, complaint_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, complaint_id`,
        [connection.id, connection.workspace_id, conversationKey, message.senderId, complaintId]
      );
    } else {
      complaintId = conversation.rows[0].complaint_id;
    }

    const activity = await client.query<{ id: string }>(
      `INSERT INTO complaint_activity_events (complaint_id, workspace_id, event_type, actor_user_id, occurred_at, metadata)
       VALUES ($1, $2, 'social_message_received', $3, coalesce($4, now()), $5::jsonb) RETURNING id`,
      [complaintId, connection.workspace_id, connection.created_by, message.sentAt,
        JSON.stringify({ provider: message.provider, externalMessageId: message.externalMessageId })]
    );
    await client.query(
      `INSERT INTO meta_social_messages
         (connection_id, conversation_id, workspace_id, activity_event_id, external_message_id, body, attachment_metadata, provider_sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [connection.id, conversation.rows[0].id, connection.workspace_id, activity.rows[0].id,
        message.externalMessageId, message.body, JSON.stringify(message.attachments), message.sentAt]
    );
    await client.query(
      `UPDATE meta_social_connections SET status = 'active', last_successful_event_at = now(),
         last_error_code = NULL, updated_at = now() WHERE id = $1`,
      [connection.id]
    );
    await client.query("COMMIT");
    return "processed" as const;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function handleMetaVerification(req: Request, res: Response) {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN ?? "";
  const mode = req.query["hub.mode"];
  const supplied = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (!expected) { res.status(503).send("Webhook verification is not configured."); return; }
  if (mode !== "subscribe" || typeof supplied !== "string" || !constantTimeEqual(expected, supplied) ||
      typeof challenge !== "string" || challenge.length < 1 || challenge.length > 200) {
    res.status(403).send("Webhook verification failed.");
    return;
  }
  res.type("text/plain").status(200).send(challenge);
}

async function handleMetaNotification(req: Request, res: Response, enqueueWebhookDeliveries: MetaRouteOptions["enqueueWebhookDeliveries"]) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) { res.status(503).json({ error: "Meta webhook verification is not configured." }); return; }
  if (!Buffer.isBuffer(req.body) || req.body.length > maxWebhookBytes) {
    res.status(413).json({ error: "Meta webhook payload is invalid or too large." }); return;
  }
  if (!verifyMetaSignature(req.body, req.get("x-hub-signature-256"), appSecret)) {
    res.status(401).json({ error: "Meta webhook signature verification failed." }); return;
  }
  let payload: unknown;
  try { payload = JSON.parse(req.body.toString("utf8")) as unknown; }
  catch { res.status(400).json({ error: "Meta webhook payload is not valid JSON." }); return; }

  let messages: SocialMessage[];
  try { messages = parseMetaMessages(payload); }
  catch { res.status(400).json({ error: "Meta webhook payload is malformed." }); return; }
  let processed = 0;
  let duplicates = 0;
  let rejected = 0;
  try {
    for (const message of messages) {
      const outcome = await persistSocialMessage(message, enqueueWebhookDeliveries);
      if (outcome === "processed") processed += 1;
      else if (outcome === "duplicate") duplicates += 1;
      else rejected += 1;
    }
  } catch {
    res.status(503).json({ error: "Meta webhook event could not be durably processed. Retry delivery." });
    return;
  }
  res.status(200).json({ accepted: true, processed, duplicates, rejected });
}

export function mountMetaWebhook(app: Application, enqueueWebhookDeliveries: MetaRouteOptions["enqueueWebhookDeliveries"]) {
  app.get("/webhooks/meta", (req, res) => { void handleMetaVerification(req, res); });
  app.post("/webhooks/meta", express.raw({ type: "application/json", limit: maxWebhookBytes }), (req, res) => {
    void handleMetaNotification(req, res, enqueueWebhookDeliveries).catch(() => {
      if (!res.headersSent) res.status(503).json({ error: "Meta webhook processing is temporarily unavailable." });
    });
  });
}

export function mountMetaSocialRoutes(app: Application, options: MetaRouteOptions) {
  const { requireAuth, csrfProtection, requireWorkspaceRole } = options;
  app.get("/workspaces/:workspaceId/integrations/meta-social",
    requireAuth, requireWorkspaceRole(["owner", "admin"]), async (req, res) => {
      const result = await pool.query(
        `SELECT id, provider, provider_account_id, business_account_id, display_name, status,
                created_at, updated_at, last_successful_event_at, last_error_code, connected_at,
                access_token_expires_at, phone_display_number, phone_verified_name,
                (access_token_ciphertext IS NOT NULL) AS authorized
         FROM meta_social_connections WHERE workspace_id = $1 ORDER BY provider, created_at DESC`,
        [String(req.params.workspaceId)]
      );
      const base = process.env.PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "");
      const callbackUrl = base && /^https:\/\//i.test(base) ? `${base}/webhooks/meta` :
        ["development", "test"].includes(process.env.NODE_ENV ?? "") && base ? `${base}/webhooks/meta` : null;
      res.json({
        connections: result.rows,
        callbackUrl,
        configuration: {
          appSecretConfigured: Boolean(process.env.META_APP_SECRET),
          verificationTokenConfigured: Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN)
        }
      });
    });

  app.post("/workspaces/:workspaceId/integrations/meta-social",
    csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), async (req, res) => {
      const body = req.body;
      if (!isRecord(body) || Object.keys(body).some((key) => !["provider", "providerAccountId", "businessAccountId", "displayName"].includes(key)) ||
          body.provider !== "instagram" || !safeId(body.providerAccountId) ||
          (body.businessAccountId !== undefined && body.businessAccountId !== null && !safeId(body.businessAccountId)) ||
          typeof body.displayName !== "string" || !body.displayName.trim() || body.displayName.trim().length > 100 ||
          (body.provider === "instagram" && body.businessAccountId !== undefined && body.businessAccountId !== null)) {
        res.status(400).json({ error: "Configure Instagram accounts here. WhatsApp accounts must use Embedded Signup." });
        return;
      }
      const user = res.locals.user as { id: string };
      try {
        const result = await pool.query(
          `INSERT INTO meta_social_connections
             (workspace_id, provider, provider_account_id, business_account_id, display_name, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (provider, provider_account_id) DO UPDATE SET
             business_account_id = EXCLUDED.business_account_id, display_name = EXCLUDED.display_name,
             status = 'pending', last_error_code = NULL, updated_at = now()
           WHERE meta_social_connections.workspace_id = EXCLUDED.workspace_id
             AND meta_social_connections.status = 'disconnected'
           RETURNING id, provider, provider_account_id, business_account_id, display_name, status,
                     created_at, updated_at, last_successful_event_at, last_error_code`,
          [String(req.params.workspaceId), body.provider, body.providerAccountId,
            body.businessAccountId ?? null, body.displayName.trim(), user.id]
        );
        if (!result.rows[0]) {
          res.status(409).json({ error: "That Meta account is already configured or belongs to another workspace." });
          return;
        }
        res.status(201).json({ connection: result.rows[0] });
      } catch (error) {
        if (isRecord(error) && error.code === "23505") {
          res.status(409).json({ error: "That Meta account is already configured." });
          return;
        }
        throw error;
      }
    });

  app.post("/workspaces/:workspaceId/integrations/meta-social/:connectionId/disconnect",
    csrfProtection, requireAuth, requireWorkspaceRole(["owner", "admin"]), async (req, res) => {
      if (!safeId(req.params.connectionId, 36)) { res.status(404).json({ error: "Meta connection not found." }); return; }
      const current = await pool.query<{ provider: Provider; business_account_id: string | null; access_token_ciphertext: string | null }>(
        `SELECT provider, business_account_id, access_token_ciphertext
         FROM meta_social_connections WHERE id = $1 AND workspace_id = $2 AND status <> 'disconnected'`,
        [req.params.connectionId, String(req.params.workspaceId)]
      );
      if (!current.rows[0]) { res.status(404).json({ error: "Meta connection not found or already disconnected." }); return; }
      if (current.rows[0].provider === "whatsapp" && current.rows[0].access_token_ciphertext && current.rows[0].business_account_id) {
        try {
          await revokeWhatsAppSubscription(
            current.rows[0].access_token_ciphertext,
            current.rows[0].business_account_id,
            options.whatsappGraphApi ?? createWhatsAppGraphApi()
          );
        } catch {
          res.status(502).json({ error: "Meta could not disconnect the WhatsApp subscription. Try again later." });
          return;
        }
      }
      const result = await pool.query(
        `UPDATE meta_social_connections SET status = 'disconnected', access_token_ciphertext = NULL,
           access_token_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND status <> 'disconnected'
         RETURNING id, provider, provider_account_id, status, updated_at`,
        [req.params.connectionId, String(req.params.workspaceId)]
      );
      if (!result.rows[0]) { res.status(404).json({ error: "Meta connection not found or already disconnected." }); return; }
      res.json({ connection: result.rows[0] });
    });
}
