import { createHash, createHmac, randomBytes } from "node:crypto";

export function generateOpaqueRoutingToken() {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest();
}

export function hashClientAddress(value: string) {
  const key = process.env.SESSION_SECRET;
  if (!key || Buffer.byteLength(key) < 32) throw new Error("Client address hashing key is not configured");
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function normalizeRecipient(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 320 || /[\r\n\0]/.test(value)) return null;
  const candidate = value.trim().replace(/^<|>$/g, "").toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(candidate)) return null;
  return candidate;
}

export function extractPlainText(html: string) {
  return html.replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const value = Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
    }).replace(/\r/g, "").replace(/[\t\f\v ]+/g, " ").replace(/ *\n */g, "\n").trim();
}

export type SafeAttachment = { filename: string; contentType: string; size: number; status: "metadata_only" | "unsupported" };

export function inspectAttachmentMetadata(value: unknown): SafeAttachment[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const result: SafeAttachment[] = [];
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const attachment = item as Record<string, unknown>;
    if (typeof attachment.size !== "number" || !Number.isInteger(attachment.size) || attachment.size < 0 || attachment.size > 10 * 1024 * 1024 ||
        typeof attachment.content_type !== "string" || attachment.content_type.length > 100 ||
        (attachment.filename !== null && attachment.filename !== undefined && typeof attachment.filename !== "string")) return null;
    total += attachment.size;
    if (total > 20 * 1024 * 1024) return null;
    const rawName = typeof attachment.filename === "string" ? attachment.filename : "attachment";
    const filename = rawName.split(/[\\/]/).pop()!.replace(/[\r\n\0]/g, "").slice(0, 120) || "attachment";
    const contentType = attachment.content_type.toLowerCase().split(";", 1)[0].trim();
    const safeMime = /^(application\/(pdf|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))|image\/(png|jpeg|gif|webp)|text\/(plain|csv))$/.test(contentType);
    result.push({ filename, contentType, size: attachment.size, status: safeMime ? "metadata_only" : "unsupported" });
  }
  return result;
}

export function inboundSuppressionReason(headers: Record<string, string> | null | undefined, from: string) {
  const normalized = Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value).toLowerCase()]));
  if ((normalized["auto-submitted"] ?? "").trim() && normalized["auto-submitted"]!.trim() !== "no") return "auto_submitted";
  if (/\b(bulk|list|junk)\b/.test(normalized.precedence ?? "")) return "precedence_automated";
  if (/mailer-daemon|postmaster/.test(from.toLowerCase())) return "automated_sender";
  if (/multipart\/report|delivery-status|report-type=delivery-status/.test(normalized["content-type"] ?? "")) return "delivery_status";
  if (normalized["x-nomaanos-generated"] !== undefined) return "nomaanos_generated";
  return null;
}

export function parseSender(value: unknown): { email: string; name: string | null } | null {
  if (typeof value !== "string" || value.length > 512 || /[\r\n\0]/.test(value)) return null;
  const match = value.trim().match(/^(?:(.*?)\s*)?<([^<>]+)>$/);
  const email = normalizeRecipient(match?.[2] ?? value.trim());
  if (!email) return null;
  const name = match?.[1]?.replace(/^"|"$/g, "").trim().replace(/[\r\n\0]/g, "").slice(0, 100) || null;
  return { email, name };
}
