"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type SubmissionKey = { signature: string; key: string };
type FieldName = "name" | "email" | "subject" | "description" | "category";
type FormFieldConfig = Record<FieldName, { enabled: boolean; required: boolean }>;
type PublicFormConfig = { active: boolean; displayName: string; fields: FormFieldConfig };
const labels: Record<FieldName, string> = { name: "Your name", email: "Email address", subject: "Complaint title", description: "What can we help with?", category: "Category" };

export function PublicContactForm({ token }: { token: string }) {
  const [active, setActive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");
  const [config, setConfig] = useState<PublicFormConfig | null>(null);
  const submissionKey = useRef<SubmissionKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/public/contact/${encodeURIComponent(token)}`, { cache: "no-store", referrerPolicy: "no-referrer" })
      .then(async (response) => {
        if (!response.ok) throw new Error("This contact form is unavailable. Check the link or contact the business directly.");
        const payload = await response.json() as { form?: PublicFormConfig };
        if (!payload.form?.active || !payload.form.fields) throw new Error("This contact form is unavailable. Check the link or contact the business directly.");
        if (!cancelled) { setConfig(payload.form); setActive(true); }
      }).catch((caught: unknown) => { if (!cancelled) { setActive(false); setError(caught instanceof Error ? caught.message : "This contact form is unavailable."); } });
    return () => { cancelled = true; };
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const body: Record<string, string> = { website: String(values.get("website") ?? "") };
    for (const key of Object.keys(config!.fields) as FieldName[]) {
      if (config!.fields[key].enabled) body[key] = String(values.get(key) ?? "");
    }
    const fingerprint = JSON.stringify(body);
    if (!submissionKey.current || submissionKey.current.signature !== fingerprint) {
      submissionKey.current = { signature: fingerprint, key: crypto.randomUUID() };
    }
    try {
      const response = await fetch(`${apiBase}/public/contact/${encodeURIComponent(token)}`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": submissionKey.current.key },
        body: JSON.stringify(body), credentials: "omit", referrerPolicy: "no-referrer"
      });
      const result = await response.json() as { status?: string; reference?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Your message could not be sent. Please try again.");
      if (result.status === "accepted" && result.reference) setReference(result.reference);
      else setReference("received");
      submissionKey.current = null;
      form.reset();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Your message could not be sent. Please try again."); }
    finally { setBusy(false); }
  }

  return <main className="public-contact-shell">
    <section className="public-contact-card" aria-labelledby="contact-heading">
      <Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link>
      <p className="eyebrow">CUSTOMER SUPPORT</p><h1 id="contact-heading">{config?.displayName || "Tell us what happened"}</h1>
      <p className="dashboard-intro">Send a message to the support team. Please avoid including passwords or payment card details.</p>
      {active === null ? <p role="status">Checking this form…</p> : !active ? <p className="analytics-error" role="alert">{error || "This contact form is unavailable."}</p> : reference ? <div className="contact-success" role="status"><h2>Your message was received</h2><p>Reference: <code>{reference}</code></p><button className="filter-button" onClick={() => { setReference(""); setError(""); }}>Send another message</button></div> : <form className="public-contact-form" onSubmit={(event) => void submit(event)}>
        {config?.fields.name.enabled && <label>{labels.name}{!config.fields.name.required && <small>Optional</small>}<input name="name" autoComplete="name" required={config.fields.name.required} maxLength={100} /></label>}
        {config?.fields.email.enabled && <label>{labels.email}{!config.fields.email.required && <small>Optional</small>}<input name="email" type="email" autoComplete="email" required={config.fields.email.required} maxLength={254} /></label>}
        {config?.fields.subject.enabled && <label>{labels.subject}<input name="subject" required={config.fields.subject.required} maxLength={200} /></label>}
        {config?.fields.category.enabled && <label>{labels.category} <small>Optional</small><select name="category" defaultValue=""><option value="">Choose a category</option><option value="payment">Payment</option><option value="refund">Refund</option><option value="delivery">Delivery</option><option value="account">Account</option><option value="technical">Technical</option><option value="product_quality">Product quality</option><option value="other">Other</option></select></label>}
        {config?.fields.description.enabled && <label>{labels.description}<textarea name="description" required={config.fields.description.required} maxLength={10000} rows={7} /></label>}
        <label className="contact-honeypot" aria-hidden="true" tabIndex={-1}>Leave this field empty<input name="website" autoComplete="off" tabIndex={-1} /></label>
        {error && <p className="analytics-error" role="alert">{error}</p>}
        <button className="filter-button" type="submit" disabled={busy}>{busy ? "Sending…" : "Send message"}</button>
      </form>}
      <p className="contact-privacy-note">Your message will be added to the business’s support queue. Replies are not sent automatically.</p>
    </section>
  </main>;
}