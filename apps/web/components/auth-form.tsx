"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isRegister = mode === "register";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const values = new FormData(event.currentTarget);
    const payload = Object.fromEntries(values.entries());
    try {
      const { data, response } = await apiRequest<Record<string, unknown>>(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not authenticate. Please try again."));
      router.push("/dashboard");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not authenticate. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-shell">
    <Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link>
    <section className="auth-card">
      <p className="eyebrow">{isRegister ? "START YOUR WORKSPACE" : "WELCOME BACK"}</p>
      <h1>{isRegister ? "Create your account" : "Sign in to NomaanOS"}</h1>
      <p className="auth-subtitle">{isRegister ? "Set up your first private workspace." : "Continue to your support workspace."}</p>
      <form onSubmit={submit}>
        {isRegister && <label>Your name<input name="name" autoComplete="name" required maxLength={100} /></label>}
        <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
        <label>Password<input name="password" type="password" autoComplete={isRegister ? "new-password" : "current-password"} required minLength={isRegister ? 12 : undefined} maxLength={128} />{isRegister && <small>Use at least 12 characters.</small>}</label>
        {isRegister && <label>Workspace name<input name="workspaceName" required maxLength={120} placeholder="Your company" /></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-link form-submit" disabled={busy}>{busy ? "Please wait…" : isRegister ? "Create account" : "Sign in"}</button>
      </form>
      <p className="auth-switch">{isRegister ? "Already have an account?" : "New to NomaanOS?"} <Link href={isRegister ? "/login" : "/register"}>{isRegister ? "Sign in" : "Create an account"}</Link></p>
    </section>
    <p className="auth-foot">Private by design. Your workspace belongs to your team.</p>
  </main>;
}
