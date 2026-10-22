import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { Resend } from "resend";
import { generateOpaqueRoutingToken, inboundSuppressionReason, inspectAttachmentMetadata, normalizeRecipient, parseSender, sha256, extractPlainText } from "../src/day8-ingestion.js";

test("Day 8 email parsing uses bounded metadata and deterministic privacy-safe routing hashes", () => {
  const token = generateOpaqueRoutingToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, generateOpaqueRoutingToken());
  assert.equal(sha256(token).length, 32);
  assert.equal(normalizeRecipient("Support+case@Example.test"), "support+case@example.test");
  assert.equal(normalizeRecipient("Support <support@example.test>"), null);
  assert.equal(normalizeRecipient("support@example.test\r\nBcc:x@y.test"), null);
  assert.deepEqual(parseSender('"Riley Client" <Riley@example.test>'), { email: "riley@example.test", name: "Riley Client" });
  assert.equal(parseSender("mailer-daemon"), null);
  assert.equal(extractPlainText("<p>Hello &amp; welcome</p><script>alert(1)</script><a href='javascript:evil'>account</a>"), "Hello & welcome\naccount");
});

test("Day 8 loop suppression and attachment metadata handling are explicit and non-fetching", () => {
  assert.equal(inboundSuppressionReason({ "Auto-Submitted": "auto-replied" }, "customer@example.test"), "auto_submitted");
  assert.equal(inboundSuppressionReason({ Precedence: "bulk" }, "customer@example.test"), "precedence_automated");
  assert.equal(inboundSuppressionReason({ "Content-Type": "multipart/report; report-type=delivery-status" }, "postmaster@example.test"), "automated_sender");
  assert.equal(inboundSuppressionReason({}, "no-reply@example.test"), null);
  assert.equal(inboundSuppressionReason({ "X-NomaanOS-Generated": "1" }, "support@example.test"), "nomaanos_generated");

  const metadata = inspectAttachmentMetadata([
    { filename: "../../invoice.pdf", size: 4096, content_type: "application/pdf" },
    { filename: "run.exe", size: 12, content_type: "application/x-msdownload" }
  ]);
  assert.deepEqual(metadata, [
    { filename: "invoice.pdf", contentType: "application/pdf", size: 4096, status: "metadata_only" },
    { filename: "run.exe", contentType: "application/x-msdownload", size: 12, status: "unsupported" }
  ]);
  assert.equal(inspectAttachmentMetadata(Array.from({ length: 11 }, () => ({ filename: "x", size: 1, content_type: "text/plain" }))), null);
  assert.equal(inspectAttachmentMetadata([{ filename: "x", size: 11 * 1024 * 1024, content_type: "text/plain" }]), null);
  assert.equal(inspectAttachmentMetadata([{ filename: "x", size: -1, content_type: "text/plain" }]), null);
});

test("Day 8 uses the installed Resend SDK verifier with exact raw bytes and rejects stale/invalid signatures", () => {
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const id = "msg_day8_signature_fixture";
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ type: "email.received", data: { email_id: "provider-id" } });
  const signature = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${id}.${timestamp}.${payload}`).digest("base64");
  const resend = new Resend("re_test_fixture_not_a_live_key");
  assert.deepEqual(resend.webhooks.verify({ payload, headers: { id, timestamp: String(timestamp), signature: `v1,${signature}` }, webhookSecret: secret }),
    { type: "email.received", data: { email_id: "provider-id" } });
  assert.throws(() => resend.webhooks.verify({ payload, headers: { id, timestamp: String(timestamp - 600), signature: `v1,${signature}` }, webhookSecret: secret }));
  assert.throws(() => resend.webhooks.verify({ payload: `${payload} `, headers: { id, timestamp: String(timestamp), signature: `v1,${signature}` }, webhookSecret: secret }));
});
