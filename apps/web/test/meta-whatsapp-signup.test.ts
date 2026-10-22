import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseWhatsAppSignupMessage } from "../lib/meta-whatsapp-signup.js";

describe("WhatsApp Embedded Signup messages", () => {
  test("accepts only the Facebook origin and valid finish data", () => {
    const payload = JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { phone_number_id: "123456789", waba_id: "987654321" }
    });
    assert.deepEqual(parseWhatsAppSignupMessage("https://www.facebook.com", payload), {
      event: "FINISH",
      assets: { phoneNumberId: "123456789", wabaId: "987654321" }
    });
    assert.equal(parseWhatsAppSignupMessage("https://evil.example", payload), null);
  });

  test("rejects malformed payloads and reports cancellation without credentials", () => {
    assert.equal(parseWhatsAppSignupMessage("https://www.facebook.com", "{"), null);
    assert.equal(parseWhatsAppSignupMessage("https://www.facebook.com", {
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { phone_number_id: "phone", waba_id: "987654321" }
    }), null);
    assert.deepEqual(parseWhatsAppSignupMessage("https://www.facebook.com", {
      type: "WA_EMBEDDED_SIGNUP",
      event: "CANCEL"
    }), { event: "CANCEL" });
  });
});
