import { lookup } from "node:dns/promises";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export const integrationEventTypes = ["complaint_created", "status_changed", "analysis_completed"] as const;
export type IntegrationEventType = typeof integrationEventTypes[number];

export function generateIntegrationCredential() {
  const prefix = randomBytes(8).toString("hex");
  const token = `nos_live_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { token, prefix, hash: hashIntegrationCredential(token) };
}

export function hashIntegrationCredential(token: string) {
  return createHash("sha256").update(token, "utf8").digest();
}

export function isValidCredentialFormat(token: string) {
  return /^nos_live_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/.test(token);
}

function encryptionKey() {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function hasIntegrationEncryptionKey() {
  return encryptionKey() !== null;
}

export function encryptWebhookSecret(secret: string) {
  const key = encryptionKey();
  if (!key) throw new Error("Webhook secret encryption is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") });
}

export function decryptWebhookSecret(encrypted: string) {
  const key = encryptionKey();
  if (!key) throw new Error("Webhook secret encryption is not configured");
  const value = JSON.parse(encrypted) as { v: number; iv: string; tag: string; data: string };
  if (value.v !== 1) throw new Error("Unsupported webhook secret ciphertext version");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8");
}

export function createWebhookSignature(secret: string, timestamp: number, rawBody: string) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function ipv4Number(address: string) {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((total, octet) => (total * 256 + Number(octet)) >>> 0, 0) >>> 0;
}

function unsafeIpv4(address: string) {
  const n = ipv4Number(address);
  if (n === null) return true;
  const inRange = (base: string, prefix: number) => {
    const value = ipv4Number(base)!;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (n & mask) === (value & mask);
  };
  return [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]].some(([base, prefix]) => inRange(base as string, prefix as number));
}

function ipv6Number(address: string) {
  if (isIP(address) !== 6 || address.includes("%")) return null;
  let input = address.toLowerCase();
  const v4 = input.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4Number(v4[1]);
    if (n === null) return null;
    input = input.slice(0, -v4[1].length) + ((n >>> 16).toString(16)) + ":" + ((n & 0xffff).toString(16));
  }
  const [left, right = ""] = input.split("::");
  const l = left ? left.split(":") : [];
  const r = right ? right.split(":") : [];
  const missing = 8 - l.length - r.length;
  if (missing < 0 || (!input.includes("::") && missing !== 0)) return null;
  const words = [...l, ...Array(missing).fill("0"), ...r].map((part) => Number.parseInt(part || "0", 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  return words.reduce((result, word) => (result << 16n) | BigInt(word), 0n);
}

function inV6Range(value: bigint, base: bigint, prefix: number) {
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (value & mask) === (base & mask);
}

function unsafeIpv6(address: string) {
  const value = ipv6Number(address);
  if (value === null) return true;
  const mappedBase = ipv6Number("::ffff:0:0")!;
  if (inV6Range(value, mappedBase, 96)) {
    const n = Number(value & 0xffffffffn);
    const v4 = `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    return unsafeIpv4(v4);
  }
  // Only global unicast is accepted; additionally exclude special-use ranges.
  if (!inV6Range(value, ipv6Number("2000::")!, 3)) return true;
  return inV6Range(value, ipv6Number("2001::")!, 23) || inV6Range(value, ipv6Number("2001:db8::")!, 32) ||
    inV6Range(value, ipv6Number("2002::")!, 16);
}

export class PermanentWebhookError extends Error {}

type ResolvedAddress = { address: string; family: number };
type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;

async function systemLookup(hostname: string): Promise<ResolvedAddress[]> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  return lookup(hostname, { all: true, verbatim: true });
}

export async function resolveSafeWebhookUrl(rawUrl: string, options: { production?: boolean; lookupAll?: LookupAll; dnsTimeoutMs?: number } = {}) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new PermanentWebhookError("Invalid webhook URL"); }
  if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash || url.href.length > 2048) {
    throw new PermanentWebhookError("Webhook URL must be HTTPS without credentials, query, or fragment");
  }
  const production = options.production ?? !["development", "test"].includes(process.env.NODE_ENV ?? "");
  const localHost = url.hostname.toLowerCase() === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (production && url.protocol !== "https:") throw new PermanentWebhookError("Webhook URLs must use HTTPS in production");
  if (url.protocol === "http:" && !(localHost && !production)) throw new PermanentWebhookError("HTTP webhooks are allowed only for localhost development");
  if (url.hostname.endsWith(".localhost") && !(localHost && !production)) throw new PermanentWebhookError("Localhost subdomains are not allowed");
  let addresses: ResolvedAddress[];
  try {
    addresses = await new Promise<ResolvedAddress[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("DNS resolution timed out")), options.dnsTimeoutMs ?? 3000);
      (options.lookupAll ?? systemLookup)(url.hostname.replace(/^\[|\]$/g, "")).then((value) => { clearTimeout(timeout); resolve(value); }, (error) => { clearTimeout(timeout); reject(error); });
    });
  }
  catch { throw new PermanentWebhookError("Webhook hostname could not be resolved safely"); }
  if (addresses.length === 0) throw new PermanentWebhookError("Webhook hostname has no addresses");
  const allowLoopback = localHost && !production;
  if (addresses.some(({ address }) => {
    const family = isIP(address);
    return family === 4 ? unsafeIpv4(address) && !(allowLoopback && address.startsWith("127.")) :
      family === 6 ? unsafeIpv6(address) && !(allowLoopback && ipv6Number(address) === 1n) : true;
  })) throw new PermanentWebhookError("Webhook hostname resolves to a private or reserved network address");
  return { url, address: addresses[0] };
}

export type WebhookSendResult = { status: number | null; retryable: boolean; summary: string };

export async function sendSignedWebhook(rawUrl: string, signingSecret: string, eventId: string, payload: unknown,
  sendOptions: { lookupAll?: LookupAll; totalTimeoutMs?: number; idleTimeoutMs?: number } = {}): Promise<WebhookSendResult> {
  const { url, address } = await resolveSafeWebhookUrl(rawUrl, { lookupAll: sendOptions.lookupAll });
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createWebhookSignature(signingSecret, timestamp, body);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: WebhookSendResult) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(value); } };
    const requestOptions = {
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      path: `${url.pathname}${url.search}`, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
        "x-nomaanos-timestamp": String(timestamp), "x-nomaanos-signature": signature, "x-nomaanos-event-id": eventId },
      lookup: (_hostname: string, lookupOptions: { all?: boolean } | ((error: NodeJS.ErrnoException | null, address: string, family: number) => void), callback?: (...args: any[]) => void) => {
        const cb = (typeof lookupOptions === "function" ? lookupOptions : callback!) as (...args: any[]) => void;
        if (typeof lookupOptions !== "function" && lookupOptions.all) cb(null, [address]);
        else cb(null, address.address, address.family);
      },
      ...(url.protocol === "https:" && !isIP(url.hostname.replace(/^\[|\]$/g, "")) ? { servername: url.hostname } : {})
    };
    const onResponse = (response: IncomingMessage) => {
      let read = 0;
      response.on("data", (chunk: Buffer) => {
        read += chunk.length;
        if (read > 2048) request.destroy(new Error("Response body exceeded limit"));
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        const success = status >= 200 && status < 300;
        const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
        finish({ status, retryable, summary: `HTTP ${status}${success ? " delivered" : retryable ? " retryable response" : " permanent response"}` });
      });
      response.on("error", () => finish({ status: response.statusCode ?? null, retryable: true, summary: "Webhook response failed" }));
    };
    const request = url.protocol === "https:"
      ? httpsRequest(requestOptions as never, onResponse)
      : httpRequest(requestOptions as never, onResponse);
    const deadline = setTimeout(() => request.destroy(new Error("Webhook request timed out")), sendOptions.totalTimeoutMs ?? 8000);
    request.setTimeout(sendOptions.idleTimeoutMs ?? 5000, () => request.destroy(new Error("Webhook request timed out")));
    request.on("error", () => finish({ status: null, retryable: true, summary: "Webhook connection or timeout error" }));
    request.end(body);
  });
}

export function webhookRetryDelayMs(attempt: number, random: () => number = Math.random) {
  const base = Math.min(60 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}
