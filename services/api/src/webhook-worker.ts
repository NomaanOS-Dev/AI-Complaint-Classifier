import type { Pool as PgPool } from "pg";
import { decryptWebhookSecret, PermanentWebhookError, sendSignedWebhook, webhookRetryDelayMs } from "./integration-security.js";
import { pool } from "./db.js";

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 5;

type ClaimedDelivery = {
  id: string; endpoint_id: string; event_id: string; payload: unknown; attempt_count: number; total_attempt_count: number;
  url: string; signing_secret_ciphertext: string; enabled: boolean; deleted_at: Date | null;
};

export async function runWebhookDeliveryBatch(database: PgPool = pool) {
  const client = await database.connect();
  const jobs: ClaimedDelivery[] = [];
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE webhook_delivery_attempts a SET finished_at = now(), outcome = 'worker_interrupted',
         response_summary = 'Worker lease expired at the automatic attempt limit'
       WHERE a.outcome = 'in_progress' AND EXISTS (
         SELECT 1 FROM webhook_deliveries d WHERE d.id = a.delivery_id AND d.state = 'pending'
           AND d.attempt_count >= $1 AND d.locked_until <= now() AND a.attempt_number = d.total_attempt_count)`,
      [MAX_ATTEMPTS]
    );
    await client.query(
      `UPDATE webhook_deliveries SET state = 'failed', locked_until = NULL,
         last_result = 'Maximum delivery attempts exceeded after worker lease expired', updated_at = now()
       WHERE state = 'pending' AND attempt_count >= $1 AND locked_until <= now()`, [MAX_ATTEMPTS]
    );
    const due = await client.query<ClaimedDelivery>(
      `SELECT d.id, d.endpoint_id, d.event_id, d.payload, d.attempt_count, d.total_attempt_count,
              e.url, e.signing_secret_ciphertext, e.enabled, e.deleted_at
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE d.state = 'pending' AND d.attempt_count < $2 AND d.next_attempt_at <= now()
         AND (d.locked_until IS NULL OR d.locked_until <= now())
       ORDER BY d.next_attempt_at, d.created_at
       FOR UPDATE OF d SKIP LOCKED LIMIT $1`, [BATCH_SIZE, MAX_ATTEMPTS]
    );
    for (const job of due.rows) {
      if (job.total_attempt_count > 0) {
        await client.query(
          `UPDATE webhook_delivery_attempts SET finished_at = now(), outcome = 'worker_interrupted',
                  response_summary = 'Worker lease expired before result was saved'
           WHERE delivery_id = $1 AND attempt_number = $2 AND finished_at IS NULL`,
          [job.id, job.total_attempt_count]
        );
      }
      const claimed = await client.query<{ attempt_count: number; total_attempt_count: number }>(
        `UPDATE webhook_deliveries SET locked_until = now() + interval '60 seconds',
           attempt_count = attempt_count + 1, total_attempt_count = total_attempt_count + 1,
           last_attempt_at = now(), updated_at = now() WHERE id = $1
         RETURNING attempt_count, total_attempt_count`, [job.id]
      );
      job.attempt_count = claimed.rows[0].attempt_count;
      job.total_attempt_count = claimed.rows[0].total_attempt_count;
      await client.query(
        `INSERT INTO webhook_delivery_attempts (delivery_id, attempt_number, outcome)
         VALUES ($1, $2, 'in_progress')`, [job.id, job.total_attempt_count]
      );
      jobs.push(job);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }

  await Promise.all(jobs.map(async (job) => {
    let status: number | null = null;
    let retryable = false;
    let summary: string;
    try {
      if (!job.enabled || job.deleted_at) throw new PermanentWebhookError("Webhook endpoint is disabled");
      let secret: string;
      try { secret = decryptWebhookSecret(job.signing_secret_ciphertext); }
      catch { throw new PermanentWebhookError("Webhook signing configuration is unavailable"); }
      const result = await sendSignedWebhook(job.url, secret, job.event_id, job.payload);
      status = result.status; retryable = result.retryable; summary = result.summary;
    } catch (error) {
      retryable = !(error instanceof PermanentWebhookError);
      summary = error instanceof PermanentWebhookError ? "Permanent endpoint or signing configuration error" : "Webhook delivery could not be completed";
    }
    const delivered = status !== null && status >= 200 && status < 300;
    const retry = !delivered && retryable && job.attempt_count < MAX_ATTEMPTS;
    const outcome = delivered ? "delivered" : retry ? "retryable_failure" : "permanent_failure";
    const delay = retry ? webhookRetryDelayMs(job.attempt_count) : 0;
    const databaseClient = await database.connect();
    try {
      await databaseClient.query("BEGIN");
      await databaseClient.query(
        `UPDATE webhook_deliveries SET state = $2, locked_until = NULL,
           next_attempt_at = CASE WHEN $2 = 'pending' THEN now() + ($3::double precision * interval '1 millisecond') ELSE next_attempt_at END,
           delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
           last_http_status = $4, last_result = $5, updated_at = now()
         WHERE id = $1`,
        [job.id, delivered ? "delivered" : retry ? "pending" : "failed", delay, status, summary]
      );
      await databaseClient.query(
        `UPDATE webhook_delivery_attempts SET finished_at = now(), http_status = $3,
           outcome = $4, response_summary = $5 WHERE delivery_id = $1 AND attempt_number = $2`,
        [job.id, job.total_attempt_count, status, outcome, summary]
      );
      await databaseClient.query("COMMIT");
    } catch {
      await databaseClient.query("ROLLBACK");
      // The delivery lease will expire and the persistent job will be recovered.
    } finally { databaseClient.release(); }
  }));
  return jobs.length;
}

export function startWebhookWorker() {
  const run = () => { void runWebhookDeliveryBatch().catch(() => console.error("Webhook delivery worker batch failed")); };
  const workerTimer = setInterval(run, 1500);
  const cleanupTimer = setInterval(() => {
    void (async () => {
      await pool.query("DELETE FROM integration_idempotency WHERE expires_at <= now()");
      await pool.query("DELETE FROM webhook_deliveries WHERE state IN ('delivered', 'failed') AND updated_at < now() - interval '180 days'");
      await pool.query(`DELETE FROM webhook_endpoints e WHERE e.deleted_at < now() - interval '180 days'
        AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id = e.id)`);
    })().catch(() => console.error("Integration retention cleanup failed"));
  }, 6 * 60 * 60 * 1000);
  workerTimer.unref(); cleanupTimer.unref();
  return () => {
    clearInterval(workerTimer);
    clearInterval(cleanupTimer);
  };
}
