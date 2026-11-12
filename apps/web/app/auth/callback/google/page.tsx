"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { apiErrorMessage, apiRequest } from "../../../../lib/api";

function GoogleCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"processing" | "success" | "error">("processing");

  useEffect(() => {
    const errorParam = searchParams.get("error");
    const errorDesc = searchParams.get("error_description");
    if (errorParam) {
      setError(errorDesc ?? `Google sign-in error: ${errorParam}`);
      setStatus("error");
      return;
    }

    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!code || !state) {
      setError("Missing authorization parameters from Google callback.");
      setStatus("error");
      return;
    }

    let isMounted = true;

    async function handleExchange() {
      try {
        const { data, response } = await apiRequest<{
          user?: { id: string; name: string; email: string };
          error?: string;
        }>("/auth/google/callback", {
          method: "POST",
          body: JSON.stringify({ code, state })
        });

        if (!response.ok) {
          throw new Error(apiErrorMessage(data, "Failed to complete Google authentication."));
        }

        if (isMounted) {
          setStatus("success");
          router.replace("/dashboard");
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Authentication failed.");
          setStatus("error");
        }
      }
    }

    void handleExchange();

    return () => {
      isMounted = false;
    };
  }, [searchParams, router]);

  return (
    <main className="auth-shell">
      <Link className="brand" href="/">
        <span className="brand-mark">N</span>
        <span>nomaan<span className="brand-light">OS</span></span>
      </Link>
      <section className="auth-card">
        {status === "processing" && (
          <div className="auth-status-container">
            <div className="auth-spinner" />
            <h1>Completing Google Sign-In…</h1>
            <p className="auth-subtitle">Securing your session and verifying identity.</p>
          </div>
        )}

        {status === "success" && (
          <div className="auth-status-container">
            <h1>Signed In Successfully</h1>
            <p className="auth-subtitle">Redirecting to your dashboard…</p>
          </div>
        )}

        {status === "error" && (
          <div className="auth-status-container">
            <p className="eyebrow" style={{ color: "var(--danger)" }}>AUTHENTICATION FAILED</p>
            <h1>Could not sign in with Google</h1>
            <p className="form-error" role="alert" style={{ marginTop: "12px", marginBottom: "20px" }}>
              {error}
            </p>
            <Link className="primary-link form-submit" href="/login">
              Back to Login
            </Link>
          </div>
        )}
      </section>
      <p className="auth-foot">Private by design. Your workspace belongs to your team.</p>
    </main>
  );
}

export default function GoogleCallbackPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-shell">
          <p className="loading-state">Loading…</p>
        </main>
      }
    >
      <GoogleCallbackContent />
    </Suspense>
  );
}
