import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
  type VerificationEmailClient
} from "../src/email-service.js";

const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;
const originalResendApiKey = process.env.RESEND_API_KEY;
const originalEmailFrom = process.env.EMAIL_FROM;
const originalWebOrigin = process.env.WEB_ORIGIN;

function captureLogs() {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  console.info = (...args: unknown[]) => {
    info.push(args.map((arg) => String(arg)).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warn.push(args.map((arg) => String(arg)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    error.push(args.map((arg) => String(arg)).join(" "));
  };
  return { info, warn, error };
}

afterEach(() => {
  console.info = originalInfo;
  console.warn = originalWarn;
  console.error = originalError;
  if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResendApiKey;
  if (originalEmailFrom === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = originalEmailFrom;
  if (originalWebOrigin === undefined) delete process.env.WEB_ORIGIN;
  else process.env.WEB_ORIGIN = originalWebOrigin;
});

describe("sendVerificationEmail delivery and error handling", () => {
  test("logs success without exposing token when Resend accepts the email", async () => {
    const logs = captureLogs();
    const rawToken = "super-secret-verification-token-1234567890";
    let sentPayload: Record<string, unknown> | undefined;

    const mockClient: VerificationEmailClient = {
      emails: {
        send: async (payload) => {
          sentPayload = payload;
          return { data: { id: "re_msg_123" }, error: null };
        }
      }
    };

    const result = await sendVerificationEmail({
      to: "user@example.com",
      name: "Alice",
      rawToken,
      customBaseUrl: "https://app.nomaanos.test",
      resendClient: mockClient
    });

    assert.equal(result.success, true);
    assert.equal(result.provider, "resend");
    assert.equal(result.error, undefined);
    assert.equal(result.link, `https://app.nomaanos.test/verify-email?token=${rawToken}`);
    assert.ok(sentPayload);
    assert.equal(sentPayload.to, "user@example.com");
    assert.match(String(sentPayload.html), new RegExp(rawToken));

    assert.equal(logs.error.length, 0);
    assert.equal(logs.warn.length, 0);
    assert.equal(logs.info.length, 1);
    assert.match(logs.info[0], /Verification email dispatched to user@example\.com via Resend/i);
    assert.doesNotMatch(logs.info.join("\n"), new RegExp(rawToken));
    assert.doesNotMatch(logs.info.join("\n"), /verify-email\?token=/);
  });

  test("logs error and returns failure when Resend returns an error object", async () => {
    const logs = captureLogs();
    const rawToken = "rejected-secret-token-abcdef123456";

    const mockClient: VerificationEmailClient = {
      emails: {
        send: async () => ({
          data: null,
          error: {
            name: "validation_error",
            statusCode: 403,
            message: "You can only send testing emails to your own email address."
          }
        })
      }
    };

    const result = await sendVerificationEmail({
      to: "recipient@gmail.com",
      name: "Bob",
      rawToken,
      resendClient: mockClient
    });

    assert.equal(result.success, false);
    assert.equal(result.provider, "resend");
    assert.match(result.error ?? "", /validation_error/);
    assert.match(result.error ?? "", /403/);
    assert.match(result.error ?? "", /You can only send testing emails/);

    assert.equal(logs.info.length, 0);
    assert.equal(logs.error.length, 1);
    assert.match(logs.error[0], /Resend rejected verification email for recipient@gmail\.com/i);
    assert.doesNotMatch(logs.error.join("\n"), new RegExp(rawToken));
  });

  test("logs error and returns failure when Resend returns neither data.id nor error", async () => {
    const logs = captureLogs();
    const rawToken = "empty-response-token-abcdef123456";

    const mockClient: VerificationEmailClient = {
      emails: {
        send: async () => ({ data: null, error: null })
      }
    };

    const result = await sendVerificationEmail({
      to: "empty@gmail.com",
      name: "Cara",
      rawToken,
      resendClient: mockClient
    });

    assert.equal(result.success, false);
    assert.equal(result.provider, "resend");
    assert.match(result.error ?? "", /without a message ID/i);
    assert.equal(logs.info.length, 0);
    assert.equal(logs.error.length, 1);
    assert.doesNotMatch(logs.error.join("\n"), new RegExp(rawToken));
  });

  test("catches unexpected exceptions, logs error without token, and returns failure", async () => {
    const logs = captureLogs();
    const rawToken = "exception-secret-token-abcdef123456";

    const mockClient: VerificationEmailClient = {
      emails: {
        send: async () => {
          throw new Error("Socket hang up");
        }
      }
    };

    const result = await sendVerificationEmail({
      to: "crash@gmail.com",
      name: "Dan",
      rawToken,
      resendClient: mockClient
    });

    assert.equal(result.success, false);
    assert.equal(result.provider, "resend");
    assert.equal(result.error, "Socket hang up");

    assert.equal(logs.info.length, 0);
    assert.equal(logs.error.length, 1);
    assert.match(logs.error[0], /Unexpected error dispatching verification email for crash@gmail\.com: Socket hang up/i);
    assert.doesNotMatch(logs.error.join("\n"), new RegExp(rawToken));
  });

  test("preserves local development verification-link logger when RESEND_API_KEY is unconfigured", async () => {
    const logs = captureLogs();
    process.env.RESEND_API_KEY = "replace-with-your-resend-api-key";
    process.env.WEB_ORIGIN = "http://localhost:3000";
    const rawToken = "local-dev-token-1234567890";

    const result = await sendVerificationEmail({
      to: "local@example.test",
      name: "Local Dev",
      rawToken
    });

    assert.equal(result.success, true);
    assert.equal(result.provider, "logged");
    assert.equal(result.link, `http://localhost:3000/verify-email?token=${rawToken}`);
    assert.equal(logs.error.length, 0);
    assert.equal(logs.info.length, 1);
    assert.match(logs.info[0], /Development\/Local mode: Verification link for local@example\.test/);
    assert.match(logs.info[0], new RegExp(rawToken));
  });
});

describe("sendPasswordResetEmail delivery and error handling", () => {
  test("uses WEB_ORIGIN, includes required branding and notices, and never logs token or URL on success", async () => {
    const logs = captureLogs();
    process.env.WEB_ORIGIN = "https://portal.nomaanos.test/";
    const rawToken = "reset-secret-token-9876543210abcdef";
    let capturedPayload: { from: string; to: string; subject: string; text: string; html: string } | undefined;

    const mockClient: VerificationEmailClient = {
      emails: {
        send: async (payload) => {
          capturedPayload = payload;
          return { data: { id: "re_reset_123" }, error: null };
        }
      }
    };

    const result = await sendPasswordResetEmail({
      to: "reset@example.com",
      name: "Alice",
      rawToken,
      resendClient: mockClient
    });

    assert.equal(result.success, true);
    assert.equal(result.provider, "resend");
    assert.equal(result.error, undefined);
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.to, "reset@example.com");
    assert.match(capturedPayload.html, /nomaan.*OS/i);
    assert.match(capturedPayload.html, /Reset Password/);
    assert.match(capturedPayload.html, new RegExp(`https://portal\\.nomaanos\\.test/reset-password\\?token=${rawToken}`));
    assert.match(capturedPayload.html, /30 minutes/i);
    assert.match(capturedPayload.html, /ignore this email/i);
    assert.match(capturedPayload.text, new RegExp(`https://portal\\.nomaanos\\.test/reset-password\\?token=${rawToken}`));

    assert.equal(logs.error.length, 0);
    assert.equal(logs.warn.length, 0);
    assert.equal(logs.info.length, 1);
    assert.match(logs.info[0], /Password reset email dispatched to reset@example\.com via Resend/i);
    assert.doesNotMatch(logs.info.join("\n"), new RegExp(rawToken));
    assert.doesNotMatch(logs.info.join("\n"), /reset-password\?token=/);
  });

  test("logs error without token/URL and returns failure when Resend rejects password reset email", async () => {
    const logs = captureLogs();
    const rawToken = "rejected-reset-token-1234567890";

    const mockClient: VerificationEmailClient = {
      emails: {
        send: async () => ({
          data: null,
          error: {
            name: "validation_error",
            statusCode: 403,
            message: "Domain not verified"
          }
        })
      }
    };

    const result = await sendPasswordResetEmail({
      to: "rejected@gmail.com",
      name: "Bob",
      rawToken,
      resendClient: mockClient
    });

    assert.equal(result.success, false);
    assert.equal(result.provider, "resend");
    assert.match(result.error ?? "", /Domain not verified/);
    assert.equal(logs.info.length, 0);
    assert.equal(logs.error.length, 1);
    assert.match(logs.error[0], /Resend rejected Password reset email for rejected@gmail\.com/);
    assert.doesNotMatch(logs.error.join("\n"), new RegExp(rawToken));
    assert.doesNotMatch(logs.error.join("\n"), /reset-password\?token=/);
  });

  test("catches unexpected exceptions without exposing token or URL", async () => {
    const logs = captureLogs();
    const rawToken = "exception-reset-token-1234567890";

    const mockClient: VerificationEmailClient = {
      emails: {
        send: async () => {
          throw new Error("Upstream connection reset");
        }
      }
    };

    const result = await sendPasswordResetEmail({
      to: "err@gmail.com",
      name: "Cara",
      rawToken,
      resendClient: mockClient
    });

    assert.equal(result.success, false);
    assert.equal(result.provider, "resend");
    assert.equal(result.error, "Upstream connection reset");
    assert.equal(logs.info.length, 0);
    assert.equal(logs.error.length, 1);
    assert.doesNotMatch(logs.error.join("\n"), new RegExp(rawToken));
    assert.doesNotMatch(logs.error.join("\n"), /reset-password\?token=/);
  });

  test("does not log reset token or URL when RESEND_API_KEY is unconfigured", async () => {
    const logs = captureLogs();
    process.env.RESEND_API_KEY = "";
    const rawToken = "unconfigured-reset-token-1234567890";

    const result = await sendPasswordResetEmail({
      to: "dev@example.test",
      name: "Dev",
      rawToken
    });

    assert.equal(result.success, false);
    assert.equal(result.provider, "logged");
    assert.equal(logs.info.length, 0);
    assert.equal(logs.warn.length, 1);
    assert.doesNotMatch(logs.warn.join("\n"), new RegExp(rawToken));
    assert.doesNotMatch(logs.warn.join("\n"), /reset-password\?token=/);
  });
});
