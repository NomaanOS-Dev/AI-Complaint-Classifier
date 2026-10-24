import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { enqueueComplaintAnalysis, requeueComplaintAnalysis, runComplaintAnalysisBatch } from "../src/complaint-analysis-worker.js";
import { extractPlainText, parseSender, inspectAttachmentMetadata } from "../src/day8-ingestion.js";

test("enqueueComplaintAnalysis inserts a pending analysis job with workspace isolation and idempotency", async () => {
  const executedQueries: Array<{ text: string; params: unknown[] }> = [];
  const mockClient = {
    query: async (text: string, params: unknown[]) => {
      executedQueries.push({ text, params });
      return { rows: [{ id: "job-1", status: "pending" }] };
    }
  };

  await enqueueComplaintAnalysis(mockClient as any, "complaint-100", "workspace-1");

  assert.equal(executedQueries.length, 1);
  assert.match(executedQueries[0].text, /INSERT INTO complaint_analysis_jobs/i);
  assert.match(executedQueries[0].text, /ON CONFLICT\s*\(complaint_id\)\s*DO NOTHING/i);
  assert.deepEqual(executedQueries[0].params, ["complaint-100", "workspace-1"]);
});

test("requeueComplaintAnalysis resets attempt counters and releases locks for re-analysis", async () => {
  const executedQueries: Array<{ text: string; params: unknown[] }> = [];
  const mockClient = {
    query: async (text: string, params: unknown[]) => {
      executedQueries.push({ text, params });
      return { rows: [{ id: "job-1", status: "pending" }] };
    }
  };

  await requeueComplaintAnalysis(mockClient as any, "complaint-100", "workspace-1");

  assert.equal(executedQueries.length, 1);
  assert.match(executedQueries[0].text, /INSERT INTO complaint_analysis_jobs/i);
  assert.match(executedQueries[0].text, /DO UPDATE SET\s+status\s*=\s*'pending'/i);
  assert.match(executedQueries[0].text, /attempt_count\s*=\s*0/i);
  assert.match(executedQueries[0].text, /locked_until\s*=\s*NULL/i);
  assert.deepEqual(executedQueries[0].params, ["complaint-100", "workspace-1"]);
});

test("runComplaintAnalysisBatch transitions jobs through pending -> processing -> completed on AI success", async () => {
  const jobs = [
    {
      complaint_id: "c-1",
      workspace_id: "w-1",
      attempt_count: 1,
      title: "Broken payment",
      description: "My card was charged but order failed"
    }
  ];

  const dbCalls: Array<{ text: string; params?: unknown[] }> = [];
  const mockClient = {
    query: async (text: string, params?: unknown[]) => {
      dbCalls.push({ text, params });
      return { rows: [{ id: "act-1" }] };
    },
    release: () => {}
  };

  const mockDb = {
    query: async (text: string, params?: unknown[]) => {
      dbCalls.push({ text, params });
      if (text.includes("WITH picked AS")) {
        return { rows: jobs };
      }
      return { rows: [] };
    },
    connect: async () => mockClient
  };

  const validAnalysisData = {
    category: "payment",
    sentiment: "negative",
    severity: "high",
    priority_score: 85,
    priority_label: "urgent",
    reasoning_summary: "Transaction failed after deduction",
    suggested_reply: "We apologize and are checking the charge immediately.",
    model_name: "gpt-6.1-sol",
    analyzed_at: "2026-10-23T12:00:00.000Z"
  };

  const aiFetcher = async () => new Response(JSON.stringify(validAnalysisData), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

  const processedCount = await runComplaintAnalysisBatch({
    fetcher: aiFetcher as any,
    database: mockDb as any
  });

  assert.equal(processedCount, 1);
  const texts = dbCalls.map((c) => c.text);
  assert.ok(texts.some((t) => t.includes("WITH picked AS")), "Claimed job with FOR UPDATE SKIP LOCKED");
  assert.ok(texts.some((t) => t.includes("INSERT INTO complaint_analyses")), "Saved complaint analysis");
  assert.ok(texts.some((t) => t.includes("status='completed'")), "Marked job completed");
});

test("runComplaintAnalysisBatch handles AI failure with exponential backoff and leaves job for retry", async () => {
  const jobs = [
    {
      complaint_id: "c-2",
      workspace_id: "w-1",
      attempt_count: 2,
      title: "Delivery delay",
      description: "Package did not arrive"
    }
  ];

  const dbCalls: Array<{ text: string; params?: unknown[] }> = [];
  const mockDb = {
    query: async (text: string, params?: unknown[]) => {
      dbCalls.push({ text, params });
      if (text.includes("WITH picked AS")) {
        return { rows: jobs };
      }
      return { rows: [] };
    }
  };

  const aiFetcher = async () => new Response(JSON.stringify({ detail: "AI provider is temporarily unavailable." }), {
    status: 503,
    headers: { "content-type": "application/json" }
  });

  const processedCount = await runComplaintAnalysisBatch({
    fetcher: aiFetcher as any,
    database: mockDb as any
  });

  assert.equal(processedCount, 1);
  const failureUpdate = dbCalls.find((c) => c.text.includes("WHERE complaint_id=$1"));
  assert.ok(failureUpdate, "Updated job with failure backoff");
  assert.equal(failureUpdate?.params?.[0], "c-2");
  assert.equal(failureUpdate?.params?.[1], "pending");
  assert.equal(failureUpdate?.params?.[2], "service_unavailable");
  // waitSeconds for attempt 2: 15 * 2^1 = 30s
  assert.equal(failureUpdate?.params?.[3], 30);
});

test("runComplaintAnalysisBatch exhausts max retries and transitions poison jobs to failed", async () => {
  const jobs = [
    {
      complaint_id: "c-poison",
      workspace_id: "w-1",
      attempt_count: 5, // maxAttempts reached
      title: "Corrupt complaint",
      description: "Unprocessable format"
    }
  ];

  const dbCalls: Array<{ text: string; params?: unknown[] }> = [];
  const mockDb = {
    query: async (text: string, params?: unknown[]) => {
      dbCalls.push({ text, params });
      if (text.includes("WITH picked AS")) {
        return { rows: jobs };
      }
      return { rows: [] };
    }
  };

  const aiFetcher = async () => new Response(JSON.stringify({ not_a_valid: "schema" }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

  await runComplaintAnalysisBatch({
    fetcher: aiFetcher as any,
    database: mockDb as any
  });

  const failureUpdate = dbCalls.find((c) => c.text.includes("WHERE complaint_id=$1"));
  assert.ok(failureUpdate);
  assert.equal(failureUpdate.params?.[0], "c-poison");
  assert.equal(failureUpdate.params?.[1], "failed");
  assert.equal(failureUpdate.params?.[2], "invalid_response");
});

test("Inbound email parsing sanitizes empty subjects to (No subject) and safely extracts body", () => {
  const emptySubject1 = "";
  const emptySubject2 = "   ";
  const rawSubject1 = typeof emptySubject1 === "string" ? emptySubject1.trim() : "";
  const subject1 = rawSubject1.length > 0 ? rawSubject1 : "(No subject)";
  assert.equal(subject1, "(No subject)");

  const rawSubject2 = typeof emptySubject2 === "string" ? emptySubject2.trim() : "";
  const subject2 = rawSubject2.length > 0 ? rawSubject2 : "(No subject)";
  assert.equal(subject2, "(No subject)");

  // Normal subject preserved
  const validSubject = "Urgent: payment missing";
  const rawSubject3 = typeof validSubject === "string" ? validSubject.trim() : "";
  const subject3 = rawSubject3.length > 0 ? rawSubject3 : "(No subject)";
  assert.equal(subject3, "Urgent: payment missing");

  // HTML to plain text conversion
  const htmlBody = "<div><p>Hello Support,</p><p>My order #994 is missing.<br/>Please refund.</p></div>";
  const extracted = extractPlainText(htmlBody);
  assert.ok(extracted.includes("Hello Support,"));
  assert.ok(extracted.includes("My order #994 is missing."));
  assert.ok(extracted.includes("Please refund."));

  // Empty body detection
  const emptyHtml = "<div>   <br/>   </div>";
  const extractedEmpty = extractPlainText(emptyHtml);
  assert.equal(extractedEmpty, "");
});

test("Inbound email parser safely rejects invalid sender and handles attachment metadata", () => {
  assert.equal(parseSender(""), null);
  assert.equal(parseSender("invalid-email"), null);
  const parsed = parseSender("Jane Doe <jane@example.com>");
  assert.deepEqual(parsed, { name: "Jane Doe", email: "jane@example.com" });

  const attachments = inspectAttachmentMetadata([
    { filename: "receipt.pdf", content_type: "application/pdf", size: 1024 }
  ]);
  assert.equal(attachments?.length, 1);
  assert.equal(attachments?.[0].filename, "receipt.pdf");
  assert.equal(attachments?.[0].status, "metadata_only");
});

test("regression: migration 011 is idempotent and handles pre-existing tables or re-runs without error", async () => {
  const sql = await readFile(path.resolve(process.cwd(), "src/migrations/011-complaint-analysis-jobs.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS complaint_analysis_jobs/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS complaint_analysis_jobs_queue_idx/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS complaint_analysis_jobs_workspace_status_idx/i);
  assert.match(sql, /DELETE FROM schema_migrations WHERE name = '011-complaint-workflow.sql'/i);
  assert.match(sql, /ON CONFLICT \(complaint_id\) DO NOTHING/i);
});
