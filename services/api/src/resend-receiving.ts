export type ResendReceivedEmail = {
  object: "email";
  id: string;
  to: string[];
  from: string;
  created_at: string;
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  message_id: string;
  attachments: Array<{ id: string; filename: string | null; size: number; content_type: string; content_id: string | null; content_disposition: string | null }>;
};

const maxProviderResponseBytes = 1024 * 1024;

export async function retrieveReceivedEmail(emailId: string, apiKey = process.env.RESEND_API_KEY) {
  if (!apiKey) throw new Error("resend_api_not_configured");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(emailId)) throw new Error("invalid_provider_email_id");
  const url = new URL(`/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`, "https://api.resend.com");
  const response = await fetch(url, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "accept-encoding": "identity" }
  });
  if (!response.ok || !response.body) throw new Error("resend_retrieval_failed");
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxProviderResponseBytes) { await response.body.cancel(); throw new Error("resend_response_too_large"); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxProviderResponseBytes) {
        await reader.cancel();
        throw new Error("resend_response_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")); }
  catch { throw new Error("resend_response_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("resend_response_invalid");
  const email = parsed as Record<string, unknown>;
  if (email.object !== "email" || typeof email.id !== "string" || !Array.isArray(email.to) || email.to.some((value) => typeof value !== "string") ||
      typeof email.from !== "string" || typeof email.subject !== "string" || typeof email.message_id !== "string" ||
      !Array.isArray(email.attachments) || (email.text !== null && typeof email.text !== "string") || (email.html !== null && typeof email.html !== "string") ||
      (email.headers !== null && (!email.headers || typeof email.headers !== "object" || Array.isArray(email.headers)))) {
    throw new Error("resend_response_invalid");
  }
  return email as ResendReceivedEmail;
}
