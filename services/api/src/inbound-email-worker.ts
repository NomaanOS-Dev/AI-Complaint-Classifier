import { pool } from "./db.js";
import { inboundSuppressionReason, inspectAttachmentMetadata, normalizeRecipient, parseSender, sha256, extractPlainText } from "./day8-ingestion.js";
import { enqueueInboundWebhookDeliveries } from "./integration-outbox.js";
import { retrieveReceivedEmail, type ResendReceivedEmail } from "./resend-receiving.js";
import { enqueueComplaintAnalysis } from "./complaint-analysis-worker.js";

type QueueEvent = { id: string; provider_email_id: string; provider_message_id: string | null; workspace_id: string; route_id: string; recipient_hash: Buffer; attempt_count: number };
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;

async function claimBatch() {
  const result = await pool.query<QueueEvent>(
    `WITH picked AS (
       SELECT id FROM resend_inbound_events
       WHERE status IN ('received','failed','processing') AND next_attempt_at <= now() AND attempt_count < 8
         AND (locked_until IS NULL OR locked_until <= now()) AND workspace_id IS NOT NULL AND route_id IS NOT NULL
       ORDER BY next_attempt_at, received_at FOR UPDATE SKIP LOCKED LIMIT 5
     )
     UPDATE resend_inbound_events e SET status = 'processing', attempt_count = e.attempt_count + 1,
       locked_until = now() + interval '60 seconds', updated_at = now()
     FROM picked WHERE e.id = picked.id
     RETURNING e.id, e.provider_email_id, e.provider_message_id, e.workspace_id, e.route_id, e.recipient_hash, e.attempt_count`
  );
  return result.rows;
}

async function setRejected(event: QueueEvent, code: string, metadata: unknown[] = []) {
  await pool.query(
    `UPDATE resend_inbound_events SET status = 'rejected', error_code = $2, attachment_metadata = $3::jsonb,
       locked_until = NULL, processed_at = now(), updated_at = now() WHERE id = $1`,
    [event.id, code, JSON.stringify(metadata)]
  );
}

type InboundEmailFetcher = (emailId: string) => Promise<ResendReceivedEmail>;

async function processEvent(event: QueueEvent, fetchEmail: InboundEmailFetcher) {
  const routeResult = await pool.query<{ recipient_hash: Buffer; enabled: boolean; revoked_at: Date | null; created_by: string }>(
    `SELECT recipient_hash, enabled, revoked_at, created_by FROM workspace_inbound_email_routes WHERE id = $1 AND workspace_id = $2`,
    [event.route_id, event.workspace_id]
  );
  const route = routeResult.rows[0];
  if (!route || !route.enabled || route.revoked_at || !Buffer.from(route.recipient_hash).equals(Buffer.from(event.recipient_hash))) {
    await setRejected(event, "route_disabled_or_rotated"); return;
  }

  const email = await fetchEmail(event.provider_email_id);
  if (email.id !== event.provider_email_id || !Array.isArray(email.to) || email.to.length > 20 ||
      !email.to.some((value) => { const recipient = normalizeRecipient(value); return recipient !== null && Buffer.from(sha256(recipient)).equals(Buffer.from(event.recipient_hash)); })) {
    await setRejected(event, "recipient_mismatch"); return;
  }
  const sender = parseSender(email.from);
  if (!sender) { await setRejected(event, "invalid_sender"); return; }
  const rawSubject = typeof email.subject === "string" ? email.subject.trim() : "";
  const subject = rawSubject.length > 0 ? rawSubject : "(No subject)";
  if (subject.length > 200) { await setRejected(event, "subject_too_long"); return; }
  const suppress = inboundSuppressionReason(email.headers, email.from);
  if (suppress) { await setRejected(event, `suppressed_${suppress}`); return; }
  const attachments = inspectAttachmentMetadata(email.attachments);
  if (attachments === null) { await setRejected(event, "invalid_attachment_metadata"); return; }
  const text = typeof email.text === "string" && email.text.trim() ? email.text.trim() : typeof email.html === "string" ? extractPlainText(email.html) : "";
  if (!text) {
    await setRejected(event, "empty_message_body", attachments ?? []);
    return;
  }
  if (text.length > 10_000) { await setRejected(event, "message_too_long", attachments); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ status: string }>("SELECT status FROM resend_inbound_events WHERE id = $1 FOR UPDATE", [event.id]);
    if (!current.rows[0] || current.rows[0].status !== "processing") { await client.query("ROLLBACK"); return; }
    if (email.message_id) {
      const duplicate = await client.query("SELECT id FROM resend_inbound_events WHERE workspace_id = $1 AND provider_message_id = $2 AND id <> $3 LIMIT 1", [event.workspace_id, email.message_id, event.id]);
      if (duplicate.rows[0]) {
        await client.query("UPDATE resend_inbound_events SET status='duplicate', provider_message_id=NULL, error_code='duplicate_message_id', attachment_metadata=$2::jsonb, locked_until=NULL, processed_at=now(), updated_at=now() WHERE id=$1", [event.id, JSON.stringify(attachments)]);
        await client.query("COMMIT"); return;
      }
    }
    const complaint = await client.query<{ id: string }>(
      `INSERT INTO complaints(workspace_id,title,description,customer_name,customer_email,source,created_by)
       VALUES($1,$2,$3,$4,$5,'inbound_email',$6) RETURNING id`,
      [event.workspace_id, subject, text, sender.name, sender.email, route.created_by]
    );
    await enqueueComplaintAnalysis(client, complaint.rows[0].id, event.workspace_id);
    const activity = await client.query<{ id: string }>(
      `INSERT INTO complaint_activity_events(complaint_id,workspace_id,event_type,actor_user_id,metadata)
       VALUES($1,$2,'complaint_created',$3,'{"source":"inbound_email"}'::jsonb) RETURNING id`,
      [complaint.rows[0].id, event.workspace_id, route.created_by]
    );
    await enqueueInboundWebhookDeliveries(client, activity.rows[0].id, event.workspace_id);
    await client.query(
      `UPDATE resend_inbound_events SET status='processed', provider_message_id=$2, complaint_id=$3,
         attachment_metadata=$4::jsonb, error_code=NULL, locked_until=NULL, processed_at=now(), updated_at=now() WHERE id=$1`,
      [event.id, email.message_id ?? event.provider_message_id, complaint.rows[0].id, JSON.stringify(attachments)]
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function runInboundEmailBatch(fetchEmail: InboundEmailFetcher) {
  const events = await claimBatch();
  for (const event of events) {
    try { await processEvent(event, fetchEmail); }
    catch (error) {
      const waitSeconds = Math.min(3600, 2 ** Math.max(0, event.attempt_count - 1) * 15);
      const errorCode = error instanceof Error && error.message === "body_unavailable" ? "body_unavailable" : "provider_or_processing_error";
      await pool.query(
        `UPDATE resend_inbound_events SET status = CASE WHEN attempt_count >= 8 THEN 'failed' ELSE 'received' END,
          error_code = $3, locked_until = NULL,
          next_attempt_at = now() + ($2 * interval '1 second'), updated_at = now() WHERE id = $1 AND status='processing'`,
        [event.id, waitSeconds, errorCode]
      );
    }
  }
  return events.length;
}

async function processBatch() {
  if (Date.now() - lastIdempotencyCleanup > 60 * 60 * 1000) {
    await pool.query("DELETE FROM public_contact_idempotency WHERE expires_at <= now()");
    await pool.query("DELETE FROM public_contact_rate_limits WHERE window_started_at < now() - interval '1 day'");
    await pool.query("DELETE FROM workspace_contact_rate_limits WHERE window_started_at < now() - interval '1 day'");
    lastIdempotencyCleanup = Date.now();
  }
  if (!process.env.RESEND_API_KEY) return;
  await runInboundEmailBatch((emailId) => retrieveReceivedEmail(emailId));
}

let lastIdempotencyCleanup = 0;

export function startInboundEmailWorker() {
  const poll = async () => {
    if (running) return;
    running = true;
    try { await processBatch(); } catch { /* leave durable queue rows for next poll */ }
    finally { running = false; timer = setTimeout(() => void poll(), 2000); }
  };
  void poll();
  return () => { if (timer) clearTimeout(timer); };
}
