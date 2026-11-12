import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  formatRateLimitMessage,
  isValidEmailAddress,
  validatePasswordResetInput
} from "../lib/password-reset.js";

describe("forgot and reset password frontend validation and wiring", () => {
  test("validates email addresses properly", () => {
    assert.equal(isValidEmailAddress("user@example.com"), true);
    assert.equal(isValidEmailAddress("  user@example.com  "), true);
    assert.equal(isValidEmailAddress(""), false);
    assert.equal(isValidEmailAddress("not-an-email"), false);
    assert.equal(isValidEmailAddress("a".repeat(250) + "@b.com"), false);
  });

  test("validates new password length and confirmation match", () => {
    assert.equal(validatePasswordResetInput("short", "short"), "Password must be between 12 and 128 characters.");
    assert.equal(validatePasswordResetInput("a".repeat(129), "a".repeat(129)), "Password must be between 12 and 128 characters.");
    assert.equal(validatePasswordResetInput("ValidPassword123!", "MismatchPassword123!"), "Passwords do not match.");
    assert.equal(validatePasswordResetInput("ValidPassword123!", "ValidPassword123!"), null);
  });

  test("formats rate-limit messages from Retry-After header", () => {
    assert.match(formatRateLimitMessage("45", "Too many requests."), /45 seconds/);
    assert.match(formatRateLimitMessage("120", "Too many requests."), /2 minutes/);
    assert.match(formatRateLimitMessage(null, "Too many requests."), /15-minute limit window/);
  });

  test("login form exposes Forgot Password link and forgot/reset pages call expected auth endpoints", () => {
    const authForm = readFileSync(path.resolve(process.cwd(), "components", "auth-form.tsx"), "utf8");
    assert.match(authForm, /href="\/forgot-password"/);
    assert.match(authForm, /Forgot Password\?/);

    const forgotForm = readFileSync(path.resolve(process.cwd(), "components", "forgot-password-form.tsx"), "utf8");
    assert.match(forgotForm, /\/auth\/forgot-password/);

    const resetForm = readFileSync(path.resolve(process.cwd(), "components", "reset-password-form.tsx"), "utf8");
    assert.match(resetForm, /\/auth\/reset-password/);
    assert.match(resetForm, /href="\/login"/);
  });
});
