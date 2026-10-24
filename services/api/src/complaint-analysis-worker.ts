import type { PoolClient, Pool } from "pg";
import { requestComplaintAnalysis } from "./complaint-analysis.js";
import { pool } from "./db.js";
import { enqueueInboundWebhookDeliveries } from "./integration-outbox.js";

type Job = { complaint_id: string; workspace_id: string; attempt_count: number; title: string; description: string };
const maxAttempts = 5;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let isStopping = false;

export async function enqueueComplaintAnalysis(client: PoolClient | Pool, complaintId: string, workspaceId: string) {
  await client.query(
    `INSERT INTO complaint_analysis_jobs(complaint_id, workspace_id, status)
     VALUES($1, $2, 'pending')
     ON CONFLICT(complaint_id) DO NOTHING`,
    [complaintId, workspaceId]
  );
}

export async function requeueComplaintAnalysis(client: PoolClient | Pool, complaintId: string, workspaceId: string) {
  await client.query(
    `INSERT INTO complaint_analysis_jobs(complaint_id, workspace_id, status, attempt_count, locked_until, error_code, next_attempt_at, updated_at)
     VALUES($1, $2, 'pending', 0, NULL, NULL, now(), now())
     ON CONFLICT(complaint_id) DO UPDATE SET
       status = 'pending',
       attempt_count = 0,
       locked_until = NULL,
       error_code = NULL,
       next_attempt_at = now(),
       updated_at = now()`,
    [complaintId, workspaceId]
  );
}

async function claimBatch(database: Pool = pool): Promise<Job[]> {
  await database.query(
    `UPDATE complaint_analysis_jobs SET status='failed', error_code='worker_interrupted',
       locked_until=NULL, updated_at=now()
     WHERE status='processing' AND attempt_count >= $1 AND locked_until <= now()`,
    [maxAttempts]
  );
  const result = await database.query<Job>(
    `WITH picked AS (
       SELECT j.complaint_id FROM complaint_analysis_jobs j
       WHERE j.status IN ('pending','processing') AND j.next_attempt_at <= now()
         AND j.attempt_count < $1 AND (j.locked_until IS NULL OR j.locked_until <= now())
       ORDER BY j.next_attempt_at, j.created_at
       FOR UPDATE SKIP LOCKED LIMIT 5
     )
     UPDATE complaint_analysis_jobs j SET status='processing', attempt_count=j.attempt_count+1,
       locked_until=now()+interval '45 seconds', updated_at=now()
     FROM picked p JOIN complaints c ON c.id=p.complaint_id
     WHERE j.complaint_id=p.complaint_id
     RETURNING j.complaint_id, j.workspace_id, j.attempt_count, c.title, c.description`,
    [maxAttempts]
  );
  return result.rows;
}

export async function persistComplaintAnalysis(
  complaintId: string,
  workspaceId: string,
  analysis: Awaited<ReturnType<typeof requestComplaintAnalysis>>,
  client?: PoolClient,
  database?: Pool
) {
  const connection = client ?? await (database ?? pool).connect();
  const ownsClient = !client;
  try {
    if (ownsClient) await connection.query("BEGIN");
    await connection.query(
      `INSERT INTO complaint_analyses
         (complaint_id,category,sentiment,severity,priority_score,priority_label,reasoning_summary,suggested_reply,model_name,analyzed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(complaint_id) DO UPDATE SET category=EXCLUDED.category,sentiment=EXCLUDED.sentiment,
         severity=EXCLUDED.severity,priority_score=EXCLUDED.priority_score,priority_label=EXCLUDED.priority_label,
         reasoning_summary=EXCLUDED.reasoning_summary,suggested_reply=EXCLUDED.suggested_reply,
         model_name=EXCLUDED.model_name,analyzed_at=EXCLUDED.analyzed_at,updated_at=now()`,
      [complaintId, analysis.category, analysis.sentiment, analysis.severity, analysis.priority_score,
        analysis.priority_label, analysis.reasoning_summary, analysis.suggested_reply, analysis.model_name, analysis.analyzed_at]
    );
    await connection.query(
      `INSERT INTO complaint_analysis_jobs(complaint_id,workspace_id,status,attempt_count,locked_until,error_code)
       VALUES($1,$2,'completed',0,NULL,NULL)
       ON CONFLICT(complaint_id) DO UPDATE SET status='completed',locked_until=NULL,error_code=NULL,updated_at=now()`,
      [complaintId, workspaceId]
    );
    const event = await connection.query<{ id: string }>(
      `INSERT INTO complaint_activity_events(complaint_id,workspace_id,event_type,actor_user_id,metadata)
       SELECT $1,$2,'analysis_completed',created_by,'{}'::jsonb FROM complaints
       WHERE id=$1 AND workspace_id=$2 RETURNING id`,
      [complaintId, workspaceId]
    );
    if (event.rows[0]) await enqueueInboundWebhookDeliveries(connection, event.rows[0].id, workspaceId);
    if (ownsClient) await connection.query("COMMIT");
  } catch (error) {
    if (ownsClient) await connection.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsClient) connection.release();
  }
}

async function recordFailure(job: Job, code: string, database: Pool = pool) {
  const terminal = job.attempt_count >= maxAttempts;
  const delaySeconds = Math.min(900, 15 * 2 ** Math.max(0, job.attempt_count - 1));
  await database.query(
    `UPDATE complaint_analysis_jobs SET status=$2, error_code=$3, locked_until=NULL,
       next_attempt_at=CASE WHEN $2='failed' THEN next_attempt_at ELSE now()+($4*interval '1 second') END, updated_at=now()
     WHERE complaint_id=$1 AND status='processing'`,
    [job.complaint_id, terminal ? "failed" : "pending", code, delaySeconds]
  );
}

export async function runComplaintAnalysisBatch(
  options: { fetcher?: typeof fetch; database?: Pool } = {}
) {
  const database = options.database ?? pool;
  const fetcher = options.fetcher ?? fetch;
  const jobs = await claimBatch(database);
  for (const job of jobs) {
    try {
      const analysis = await requestComplaintAnalysis(job, fetcher);
      await persistComplaintAnalysis(job.complaint_id, job.workspace_id, analysis, undefined, database);
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "processing_failed";
      await recordFailure(job, code, database);
    }
  }
  return jobs.length;
}

export function startComplaintAnalysisWorker(
  options: { intervalMs?: number; fetcher?: typeof fetch; database?: Pool } = {}
) {
  isStopping = false;
  const intervalMs = options.intervalMs ?? 2000;
  const poll = async () => {
    if (isStopping) return;
    if (running) return;
    running = true;
    try {
      await runComplaintAnalysisBatch({ fetcher: options.fetcher, database: options.database });
    } catch (error) {
      console.error("Complaint analysis worker batch failed", error instanceof Error ? error.message : "unknown_error");
    } finally {
      running = false;
      if (!isStopping) {
        timer = setTimeout(() => void poll(), intervalMs);
      }
    }
  };
  void poll();
  return () => {
    isStopping = true;
    if (timer) clearTimeout(timer);
  };
}
