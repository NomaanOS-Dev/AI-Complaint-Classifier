import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contactFrameAncestors } from "../lib/contact-frame-policy.js";

describe("public contact form frame policy", () => {
  test("allows only self and the exact configured HTTPS or localhost origins", () => {
    assert.equal(contactFrameAncestors(true, [
      "https://support.example.com", "http://localhost:3000", "https://evil.example/path", "javascript:alert(1)", "*"
    ]), "'self' https://support.example.com http://localhost:3000");
  });

  test("fails closed for revoked forms and empty or malformed settings", () => {
    assert.equal(contactFrameAncestors(false, ["https://support.example.com"]), "'none'");
    assert.equal(contactFrameAncestors(true, null), "'self'");
  });
});
