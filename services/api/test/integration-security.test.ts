import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, describe, test } from "node:test";
import {
  createWebhookSignature, decryptWebhookSecret, encryptWebhookSecret, generateIntegrationCredential,
  hashIntegrationCredential, isValidCredentialFormat, PermanentWebhookError, resolveSafeWebhookUrl,
  sendSignedWebhook, webhookRetryDelayMs
} from "../src/integration-security.js";

const oldKey = process.env.INTEGRATION_ENCRYPTION_KEY;
const oldNodeEnv = process.env.NODE_ENV;
const testKey = randomBytes(32).toString("base64");
process.env.INTEGRATION_ENCRYPTION_KEY = testKey;
process.env.NODE_ENV = "test";
let receiver: ReturnType<typeof createServer> | undefined;
let redirectTarget: ReturnType<typeof createServer> | undefined;
let timeoutReceiver: ReturnType<typeof createServer> | undefined;

after(async () => {
  if (receiver) await new Promise<void>((resolve, reject) => receiver!.close((error) => error ? reject(error) : resolve()));
  if (redirectTarget) await new Promise<void>((resolve, reject) => redirectTarget!.close((error) => error ? reject(error) : resolve()));
  if (timeoutReceiver) await new Promise<void>((resolve, reject) => timeoutReceiver!.close((error) => error ? reject(error) : resolve()));
  if (oldKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY; else process.env.INTEGRATION_ENCRYPTION_KEY = oldKey;
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
});

describe("integration credential and webhook security", () => {
  test("integration credentials are high entropy and hashed", () => {
    const first = generateIntegrationCredential();
    const second = generateIntegrationCredential();
    assert.match(first.token, /^nos_live_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
    assert.equal(isValidCredentialFormat(first.token), true);
    assert.equal(first.hash.equals(hashIntegrationCredential(first.token)), true);
    assert.notEqual(first.token, second.token);
    assert.notEqual(first.hash.toString("hex"), first.token);
  });

  test("webhook secrets are authenticated-encrypted at rest and signatures are verifiable", () => {
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const ciphertext = encryptWebhookSecret(secret);
    assert.equal(ciphertext.includes(secret), false);
    assert.equal(decryptWebhookSecret(ciphertext), secret);
    const body = JSON.stringify({ id: "event-1", type: "complaint_created" });
    const timestamp = 1800000000;
    assert.equal(createWebhookSignature(secret, timestamp, body), `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`);
  });

  test("SSRF validation rejects private, metadata, loopback production, redirects, and unsafe DNS", async () => {
    const privateDns = async () => [{ address: "10.12.0.9", family: 4 }];
    await assert.rejects(resolveSafeWebhookUrl("https://callback.example/hook", { production: true, lookupAll: privateDns }), PermanentWebhookError);
    await assert.rejects(resolveSafeWebhookUrl("https://metadata.google.internal/computeMetadata/v1", { production: true, lookupAll: async () => [{ address: "169.254.169.254", family: 4 }] }), PermanentWebhookError);
    await assert.rejects(resolveSafeWebhookUrl("http://127.0.0.1/hook", { production: true }), PermanentWebhookError);
    await assert.rejects(resolveSafeWebhookUrl("https://callback.example/hook", { production: true, lookupAll: async () => [{ address: "fd00::1", family: 6 }] }), PermanentWebhookError);
    await assert.rejects(resolveSafeWebhookUrl("https://callback.example/hook", { production: true, lookupAll: async () => { throw new Error("DNS failure"); } }), PermanentWebhookError);
    await assert.rejects(resolveSafeWebhookUrl("https://callback.example/hook", { production: true, dnsTimeoutMs: 15, lookupAll: async () => new Promise(() => undefined) }), PermanentWebhookError);
    const safe = await resolveSafeWebhookUrl("https://callback.example/hook", { production: true, lookupAll: async () => [{ address: "8.8.8.8", family: 4 }] });
    assert.equal(safe.url.hostname, "callback.example");
    assert.equal((await resolveSafeWebhookUrl("http://localhost/hook", { production: false, lookupAll: async () => [{ address: "127.0.0.1", family: 4 }] })).url.hostname, "localhost");
  });

  test("delivery pins localhost in tests, signs exact bytes, and does not follow redirects", async () => {
    let body = ""; let signature = ""; let timestamp = ""; let eventId = ""; let redirectHit = 0;
    redirectTarget = createServer((_request, response) => { redirectHit++; response.end("should not be reached"); });
    redirectTarget.listen(0, "127.0.0.1"); await once(redirectTarget, "listening");
    const redirectAddress = redirectTarget.address(); assert.ok(redirectAddress && typeof redirectAddress !== "string");
    receiver = createServer((request, response) => {
      request.setEncoding("utf8"); request.on("data", (chunk) => body += chunk);
      request.on("end", () => {
        signature = request.headers["x-nomaanos-signature"] as string;
        timestamp = request.headers["x-nomaanos-timestamp"] as string;
        eventId = request.headers["x-nomaanos-event-id"] as string;
        response.writeHead(302, { location: `http://127.0.0.1:${redirectAddress.port}/redirect` }); response.end();
      });
    });
    receiver.listen(0, "127.0.0.1"); await once(receiver, "listening");
    const address = receiver.address(); assert.ok(address && typeof address !== "string");
    const payload = { id: "stable-event-123", type: "complaint_created", workspaceId: "workspace-1" };
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const result = await sendSignedWebhook(`http://127.0.0.1:${address.port}/callback`, secret, payload.id, payload);
    assert.equal(result.status, 302);
    assert.equal(result.retryable, false);
    assert.equal(eventId, payload.id);
    assert.equal(body, JSON.stringify(payload));
    assert.equal(signature, createWebhookSignature(secret, Number(timestamp), body));
    assert.equal(redirectHit, 0);
    let dnsLookups = 0;
    const pinned = await sendSignedWebhook(`http://localhost:${address.port}/callback`, secret, payload.id, payload, {
      lookupAll: async (hostname) => { dnsLookups++; assert.equal(hostname, "localhost"); return [{ address: "127.0.0.1", family: 4 }]; }
    });
    assert.equal(pinned.status, 302);
    assert.equal(dnsLookups, 1);
  });

  test("webhook request timeout is bounded", async () => {
    timeoutReceiver = createServer(() => undefined);
    timeoutReceiver.listen(0, "127.0.0.1"); await once(timeoutReceiver, "listening");
    const address = timeoutReceiver.address(); assert.ok(address && typeof address !== "string");
    const result = await sendSignedWebhook(`http://127.0.0.1:${address.port}/stall`, "test-secret", "event-timeout", {}, { totalTimeoutMs: 100, idleTimeoutMs: 25 });
    assert.equal(result.status, null);
    assert.equal(result.retryable, true);
  });

  test("retry delay is exponential with bounded jitter", () => {
    assert.equal(webhookRetryDelayMs(1, () => 0), 500);
    assert.equal(webhookRetryDelayMs(1, () => 1), 1000);
    assert.equal(webhookRetryDelayMs(20, () => 1), 3_600_000);
  });
});
