"use client";

import Link from "next/link";
import { BrandLockup } from "./brand-logo";
import { ThemeToggleButton } from "./theme-provider";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState("");
  const isRegister = mode === "register";

  async function handleGoogleSignIn() {
    if (busy || googleBusy) return;
    setError("");
    setGoogleBusy(true);
    try {
      const { data, response } = await apiRequest<{ configured: boolean; url?: string; message?: string }>("/auth/google/url");
      if (!response.ok) {
        throw new Error(apiErrorMessage(data, "Failed to start Google sign-in."));
      }
      if (!data.configured || !data.url) {
        throw new Error(
          data.message ?? "Google OAuth is not configured on this server. Please sign in with your email and password."
        );
      }
      window.location.href = data.url;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to connect to Google.");
      setGoogleBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || googleBusy) return;
    setError("");
    setBusy(true);
    const values = new FormData(event.currentTarget);
    const payload = Object.fromEntries(values.entries());
    const emailVal = typeof payload.email === "string" ? payload.email.trim() : "";

    try {
      const { data, response } = await apiRequest<{
        verificationRequired?: boolean;
        user?: { email_verified?: boolean };
        error?: string;
      }>(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (!response.ok && response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const retryMessage = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds < 60
            ? `Please try again in ${retryAfterSeconds} seconds.`
            : `Please try again in about ${Math.ceil(retryAfterSeconds / 60)} minutes.`
          : "Please wait for the 15-minute limit window to reset before trying again.";
        throw new Error(`Too many authentication attempts. ${retryMessage}`);
      }

      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not authenticate. Please try again."));

      if (data.verificationRequired || (data.user && !data.user.email_verified)) {
        router.push(`/verify-email?email=${encodeURIComponent(emailVal)}`);
        return;
      }

      router.push("/dashboard");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not authenticate. Please try again.");
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
        <p className="eyebrow">{isRegister ? "START YOUR WORKSPACE" : "WELCOME BACK"}</p>
        <h1>{isRegister ? "Create your account" : "Sign in to NomaanOS"}</h1>
        <p className="auth-subtitle">
          {isRegister ? "Set up your first private workspace." : "Continue to your support workspace."}
        </p>

        <button
          type="button"
          className="google-auth-button"
          onClick={() => void handleGoogleSignIn()}
          disabled={busy || googleBusy}
          aria-label="Continue with Google"
        >
          <svg className="google-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.66v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.15z"/>
            <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.94H1.26v3.13C3.26 21.36 7.36 24 12 24z"/>
            <path fill="#FBBC05" d="M5.28 14.26c-.25-.72-.38-1.49-.38-2.26s.13-1.54.38-2.26V6.61H1.26C.46 8.2.01 9.99.01 12c0 2.01.45 3.8 1.25 5.39l4.02-3.13z"/>
            <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.94 1.19 15.24 0 12 0 7.36 0 3.26 2.64 1.26 6.61l4.02 3.13c.95-2.84 3.6-4.99 6.72-4.99z"/>
          </svg>
          <span>{googleBusy ? "Connecting to Google…" : isRegister ? "Sign up with Google" : "Continue with Google"}</span>
        </button>

        <div className="auth-divider">
          <span>or continue with email</span>
        </div>

        <form onSubmit={submit}>
          {isRegister && <label>Your name<input name="name" autoComplete="name" required maxLength={100} /></label>}
          <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
          <label>
            <span className="auth-label-row">
              <span>Password</span>
              {!isRegister && (
                <Link className="auth-forgot-link" href="/forgot-password">
                  Forgot Password?
                </Link>
              )}
            </span>
            <input
              name="password"
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              required
              minLength={isRegister ? 12 : undefined}
              maxLength={128}
            />
            {isRegister && <small>Use at least 12 characters.</small>}
          </label>
          {isRegister && <label>Workspace name<input name="workspaceName" required maxLength={120} placeholder="Your company" /></label>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-link form-submit" disabled={busy || googleBusy}>
            {busy ? "Please wait…" : isRegister ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="auth-switch">
          {isRegister ? "Already have an account?" : "New to NomaanOS?"}{" "}
          <Link href={isRegister ? "/login" : "/register"}>
            {isRegister ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </section>
      <p className="auth-foot">Private by design. Your workspace belongs to your team.</p>
    </main>
  );
}
