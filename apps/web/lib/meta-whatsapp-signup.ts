export type WhatsAppSignupAssets = { phoneNumberId: string; wabaId: string };
export type WhatsAppSignupMessage = { event: "FINISH"; assets: WhatsAppSignupAssets } | { event: "CANCEL" | "ERROR" };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function metaId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,32}$/.test(value);
}

export function parseWhatsAppSignupMessage(origin: string, rawData: unknown): WhatsAppSignupMessage | null {
  if (origin !== "https://www.facebook.com") return null;
  let message = rawData;
  if (typeof rawData === "string") {
    try { message = JSON.parse(rawData) as unknown; }
    catch { return null; }
  }
  if (!record(message) || message.type !== "WA_EMBEDDED_SIGNUP" || typeof message.event !== "string") return null;
  if (message.event === "CANCEL" || message.event === "ERROR") return { event: message.event };
  if (message.event !== "FINISH" || !record(message.data)) return null;
  const phoneNumberId = message.data.phone_number_id;
  const wabaId = message.data.waba_id;
  if (!metaId(phoneNumberId) || !metaId(wabaId)) return null;
  return { event: "FINISH", assets: { phoneNumberId, wabaId } };
}
