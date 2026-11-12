"use client";

import Link from "next/link";
import { BrandLockup } from "./brand-logo";
import { ThemeToggleButton } from "./theme-provider";
import { FormEvent, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";
import { formatRateLimitMessage, isValidEmailAddress } from "../lib/password-reset";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");

    const trimmedEmail = email.trim();
    if (!isValidEmailAddress(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }

    setBusy(true);
    try {
      const { data, response } = await apiRequest<{ message?: string; error?: string }>("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: trimmedEmail })
      });

      if (!response.ok && response.status === 429) {
        throw new Error(formatRateLimitMessage(response.headers.get("retry-after"), "Too many password reset requests."));
      }

      if (!response.ok) {
        throw new Error(apiErrorMessage(data, "Unable to process password reset request. Please try again."));
      }

      setSuccessMessage(
        data.message ?? "If an account exists for that email address, we have sent password reset instructions."
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to process password reset request. Please try again."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-top-bar">
        <BrandLockup href="/" />
        <ThemeToggleButton />
      </div>

      <section className="auth-card">
        <p className="eyebrow">ACCOUNT RECOVERY</p>
        <h1>Reset your password</h1>
        <p className="auth-subtitle">
          Enter your registered email address and we will send you a single-use reset link.
        </p>

        {successMessage ? (
          <div className="auth-status-container" style={{ alignItems: "stretch", textAlign: "left" }}>
            <p className="integration-notice" role="status" style={{ margin: "0 0 16px 0" }}>
              {successMessage}
            </p>
            <Link className="primary-link form-submit" href="/login">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <label>
              Registered email
              <input
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
                placeholder="name@company.com"
                disabled={busy}
              />
            </label>

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <button className="primary-link form-submit" disabled={busy}>
              {busy ? "Sending reset link…" : "Send reset link"}
            </button>
          </form>
        )}

        <p className="auth-switch">
          Remembered your password? <Link href="/login">Back to sign in</Link>
        </p>
      </section>

      <p className="auth-foot">Private by design. Your workspace belongs to your team.</p>
    </main>
  );
}
