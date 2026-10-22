export type ComplaintAnalysis = {
  category: "payment" | "refund" | "delivery" | "account" | "technical" | "product_quality" | "other";
  sentiment: "positive" | "neutral" | "negative";
  severity: "low" | "medium" | "high" | "critical";
  priority_score: number;
  priority_label: "low" | "medium" | "high" | "urgent";
  reasoning_summary: string;
  suggested_reply: string;
  model_name: string;
  analyzed_at: string;
};

export class ComplaintAnalysisError extends Error {
  constructor(readonly code: "timeout" | "service_unavailable" | "invalid_response" | "not_configured") {
    super("Complaint analysis could not be completed.");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validComplaintAnalysis(value: unknown): value is ComplaintAnalysis {
  if (!isObject(value)) return false;
  const expectedKeys = ["category", "sentiment", "severity", "priority_score", "priority_label", "reasoning_summary", "suggested_reply", "model_name", "analyzed_at"];
  if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some((key) => !(key in value))) return false;
  const score = value.priority_score;
  const expectedLabel = typeof score === "number" && score < 25 ? "low" : typeof score === "number" && score < 50 ? "medium" : typeof score === "number" && score < 80 ? "high" : "urgent";
  return ["payment", "refund", "delivery", "account", "technical", "product_quality", "other"].includes(value.category as string) &&
    ["positive", "neutral", "negative"].includes(value.sentiment as string) &&
    ["low", "medium", "high", "critical"].includes(value.severity as string) &&
    typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= 100 &&
    ["low", "medium", "high", "urgent"].includes(value.priority_label as string) && value.priority_label === expectedLabel &&
    typeof value.reasoning_summary === "string" && value.reasoning_summary.trim().length >= 1 && value.reasoning_summary.length <= 300 &&
    typeof value.suggested_reply === "string" && value.suggested_reply.trim().length >= 1 && value.suggested_reply.length <= 1200 &&
    typeof value.model_name === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.model_name) &&
    typeof value.analyzed_at === "string" && Number.isFinite(Date.parse(value.analyzed_at)) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.analyzed_at);
}

export async function requestComplaintAnalysis(
  complaint: { title: string; description: string },
  fetcher: typeof fetch = fetch
): Promise<ComplaintAnalysis> {
  const configuredTimeout = Number(process.env.AI_SERVICE_TIMEOUT_MS ?? 30000);
  const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout >= 100 && configuredTimeout <= 30000 ? configuredTimeout : 30000;
  const serviceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8001";
  let response: Response;
  try {
    response = await fetcher(`${serviceUrl.replace(/\/$/, "")}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: complaint.title, description: complaint.description }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ComplaintAnalysisError("timeout");
    }
    throw new ComplaintAnalysisError("service_unavailable");
  }

  let body: unknown;
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 16000) throw new Error("oversized");
    body = JSON.parse(raw) as unknown;
  } catch {
    throw new ComplaintAnalysisError("invalid_response");
  }
  if (!response.ok) {
    if (response.status === 503 && isObject(body) && body.detail === "AI analysis is not configured on the server.") {
      throw new ComplaintAnalysisError("not_configured");
    }
    if (response.status === 504) throw new ComplaintAnalysisError("timeout");
    throw new ComplaintAnalysisError("service_unavailable");
  }
  if (!validComplaintAnalysis(body)) throw new ComplaintAnalysisError("invalid_response");
  return body;
}
