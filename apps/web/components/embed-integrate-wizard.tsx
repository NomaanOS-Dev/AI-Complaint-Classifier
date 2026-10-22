"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";
import { embedSnippetFor, sourceFor, type Technology } from "../lib/integration-snippets";

type Workspace = { id: string; name: string; role: "owner" | "admin" | "member" };
type Credential = { id: string; name: string; key_prefix: string; expires_at: string | null; revoked_at: string | null };
type FieldKey = "name" | "email" | "subject" | "description" | "category";
type Fields = Record<FieldKey, { enabled: boolean; required: boolean }>;
type EmbedForm = { id: string; display_name: string; fields: Fields; allowed_origins: string[]; enabled: boolean; revoked_at: string | null };
const initialFields: Fields = {
  name: { enabled: true, required: false }, email: { enabled: true, required: false },
  subject: { enabled: true, required: true }, description: { enabled: true, required: true }, category: { enabled: false, required: false }
};
const fieldLabels: Record<FieldKey, string> = { name: "Customer name", email: "Email address", subject: "Complaint title", description: "Complaint description", category: "Category" };

const technologies: Technology[] = ["HTML + JavaScript", "React", "Next.js", "Generic backend"];

export function EmbedIntegrateWizard() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [forms, setForms] = useState<EmbedForm[]>([]);
  const [formUrl, setFormUrl] = useState("");
  const [activeFormId, setActiveFormId] = useState("");
  const [editingFormId, setEditingFormId] = useState("");
  const [formName, setFormName] = useState("Customer support");
  const [fields, setFields] = useState<Fields>(initialFields);
  const [origins, setOrigins] = useState("");
  const [option, setOption] = useState<"embed" | "existing">("embed");
  const [step, setStep] = useState(1);
  const [technology, setTechnology] = useState<Technology>("HTML + JavaScript");
  const [connectStep, setConnectStep] = useState(1);
  const [credentialId, setCredentialId] = useState("");
  const [credentialName, setCredentialName] = useState("Website contact form");
  const [oneTimeSecret, setOneTimeSecret] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (id: string) => {
    if (!id) return;
    setBusy(true); setError("");
    try {
      const [credentialResult, formResult] = await Promise.all([
        apiRequest<{ credentials: Credential[] }>(`/workspaces/${id}/integrations/credentials`),
        apiRequest<{ forms: EmbedForm[] }>(`/workspaces/${id}/integrations/embed-forms`)
      ]);
      const failure = [credentialResult, formResult].find((result) => !result.response.ok);
      if (failure) throw new Error(apiErrorMessage(failure.data, "Integration settings are available to workspace owners and admins."));
      setCredentials(credentialResult.data.credentials); setForms(formResult.data.forms);
      if (!credentialId) setCredentialId(credentialResult.data.credentials.find((item) => !item.revoked_at && (!item.expires_at || Date.parse(item.expires_at) > Date.now()))?.id ?? "");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load integration settings."); }
    finally { setBusy(false); }
  }, [credentialId]);

  useEffect(() => {
    apiRequest<{ workspaces: Workspace[] }>("/workspaces").then(({ data, response }) => {
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not load workspaces."));
      setWorkspaces(data.workspaces);
      const requested = new URLSearchParams(window.location.search).get("workspaceId");
      const selected = data.workspaces.find((item) => item.id === requested)?.id ?? data.workspaces[0]?.id ?? "";
      setWorkspaceId(selected); if (selected) void refresh(selected);
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load workspaces."));
  }, [refresh, router]);

  const embedSnippet = useMemo(() => formUrl ? embedSnippetFor(formUrl, technology) : "", [formUrl, technology]);
  const existingSnippet = useMemo(() => sourceFor(technology), [technology]);

  async function createForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const allowedOrigins = origins.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
      const { data, response } = await apiRequest<{ form?: EmbedForm; formUrl?: string; error?: string }>(
        `/workspaces/${workspaceId}/integrations/embed-forms${editingFormId ? `/${editingFormId}` : ""}`, {
        method: editingFormId ? "PATCH" : "POST", body: JSON.stringify({ displayName: formName, fields, allowedOrigins })
      });
      if (!response.ok || (!editingFormId && !data.formUrl)) throw new Error(apiErrorMessage(data, "Could not save the embed form."));
      if (data.formUrl) { setFormUrl(data.formUrl); setActiveFormId(data.form?.id ?? ""); }
      setEditingFormId(""); setStep(2); setNotice(editingFormId ? "Form settings updated. The existing public URL remains valid." : "Embed form created. Its public URL is rate-limited and can be revoked from this page."); await refresh(workspaceId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save the embed form."); }
    finally { setSaving(false); }
  }

  async function rotateForm(form: EmbedForm) {
    setSaving(true); setError("");
    try {
      const { data, response } = await apiRequest<{ formUrl?: string; error?: string }>(`/workspaces/${workspaceId}/integrations/embed-forms/${form.id}/rotate`, { method: "POST", body: "{}" });
      if (!response.ok || !data.formUrl) throw new Error(apiErrorMessage(data, "Could not rotate the form link."));
      setFormUrl(data.formUrl); setActiveFormId(form.id); setEditingFormId(""); setFormName(form.display_name); setFields(form.fields); setOrigins(form.allowed_origins.join("\n")); setOption("embed"); setStep(2);
      setNotice("The old public form URL was invalidated. Copy the replacement URL into your website.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not rotate the form link."); }
    finally { setSaving(false); }
  }

  async function revokeForm(form: EmbedForm) {
    setSaving(true); setError("");
    try {
      const { data, response } = await apiRequest<Record<string, unknown>>(`/workspaces/${workspaceId}/integrations/embed-forms/${form.id}/revoke`, { method: "POST", body: "{}" });
      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not revoke this form."));
      if (activeFormId === form.id) { setFormUrl(""); setActiveFormId(""); }
      setNotice("Embed form revoked. Its public URL no longer accepts submissions."); await refresh(workspaceId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not revoke this form."); }
    finally { setSaving(false); }
  }

  async function createCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const { data, response } = await apiRequest<{ credential?: Credential; secret?: string; error?: string }>(`/workspaces/${workspaceId}/integrations/credentials`, {
        method: "POST", body: JSON.stringify({ name: credentialName })
      });
      if (!response.ok || !data.secret || !data.credential) throw new Error(apiErrorMessage(data, "Could not create an API credential."));
      setCredentialId(data.credential.id); setOneTimeSecret(data.secret); setNotice("Credential created. Copy and store it securely; NomaanOS will not show it again."); await refresh(workspaceId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create an API credential."); }
    finally { setSaving(false); }
  }

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice("Copied to clipboard."); }
    catch { setError("Clipboard access failed. Select and copy the code manually."); }
  }

  return <main className="dashboard-shell integrations-shell"><nav className="topbar"><Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link><div className="complaint-nav"><Link className="text-button" href={`/integrations${workspaceId ? `?workspaceId=${workspaceId}` : ""}`}>← Integrations</Link><Link className="text-button" href="/dashboard">Dashboard</Link></div></nav>
    <section className="dashboard-content embed-wizard">
      <p className="eyebrow">INTEGRATIONS · SETUP WIZARD</p><h1>Embed &amp; Integrate Form</h1><p className="dashboard-intro">Choose a hosted NomaanOS form for your website or connect your existing form through your own server.</p>
      {workspaceId && <label className="embed-workspace">Workspace<select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setFormUrl(""); setActiveFormId(""); setEditingFormId(""); setOneTimeSecret(""); setConnectStep(1); void refresh(event.target.value); }}>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label>}
      {error && <p className="analytics-error" role="alert">{error}</p>}{notice && <p className="integration-notice" role="status">{notice}</p>}
      {busy ? <p className="loading-state" role="status">Loading workspace integrations…</p> : <>
        <div className="embed-options" role="tablist" aria-label="Integration method"><button role="tab" aria-selected={option === "embed"} className={option === "embed" ? "embed-option active" : "embed-option"} onClick={() => setOption("embed")}><strong>Option A · Embed Form</strong><span>Add a ready-made NomaanOS complaint form directly to your website.</span></button><button role="tab" aria-selected={option === "existing"} className={option === "existing" ? "embed-option active" : "embed-option"} onClick={() => { setOption("existing"); setConnectStep(1); }}><strong>Option B · Connect Existing Form</strong><span>Keep your current website form and send submissions from your server to NomaanOS.</span></button></div>
        {option === "embed" ? <section className="workspace-panel embed-step"><div className="embed-step-indicator"><span aria-current={step === 1 ? "step" : undefined}>1 · Configure</span><span aria-current={step === 2 ? "step" : undefined}>2 · Install &amp; test</span></div>
          {step === 1 ? <form onSubmit={(event) => void createForm(event)} className="embed-config-form"><label>Form display name<input value={formName} onChange={(event) => setFormName(event.target.value)} required maxLength={100} /></label>
            <fieldset className="embed-field-options"><legend>Fields on the form</legend>{(Object.keys(fields) as FieldKey[]).map((key) => <div className="embed-field-row" key={key}><label><input type="checkbox" checked={fields[key].enabled} disabled={key === "subject" || key === "description"} onChange={(event) => setFields((current) => ({ ...current, [key]: { enabled: event.target.checked, required: event.target.checked && current[key].required } }))} />{fieldLabels[key]}{(key === "subject" || key === "description") && <small>Required for every complaint</small>}</label><label><input type="checkbox" checked={fields[key].required} disabled={!fields[key].enabled || key === "category"} onChange={(event) => setFields((current) => ({ ...current, [key]: { ...current[key], required: event.target.checked } }))} />Required</label></div>)}</fieldset>
            <label>Websites allowed to embed this form <small>Enter 1–10 origins, one per line. Use HTTPS in production and http://localhost:3000 for local testing.</small><textarea rows={3} required value={origins} onChange={(event) => setOrigins(event.target.value)} placeholder="https://www.example.com" /></label>
            <div className="embed-form-preview"><strong>Preview</strong>{(Object.keys(fields) as FieldKey[]).filter((key) => fields[key].enabled).map((key) => <label key={key}>{fieldLabels[key]}{fields[key].required ? " *" : ""}<input disabled placeholder={fieldLabels[key]} /></label>)}<button type="button" disabled>Send complaint</button></div>
            <p className="contact-privacy-note">The iframe uses the same hashed public form token, workspace resolution, validation, rate limits, idempotency, and revocation as the hosted form. It never contains an API credential.</p>
            <button className="filter-button" disabled={saving || !workspaceId}>{saving ? "Saving form…" : editingFormId ? "Save form settings" : "Create embed form"}</button>
          </form> : <div className="embed-install"><h2>Install the form</h2><p>Place this code where the complaint form should appear. The generated URL uses the public form token, not an API credential.</p>
            <div className="embed-tabs" role="tablist" aria-label="Website technology">{technologies.slice(0, 3).map((item) => <button key={item} role="tab" aria-selected={technology === item} onClick={() => setTechnology(item)}>{item}</button>)}</div>
            <pre className="integration-code"><code>{embedSnippet}</code></pre><button className="filter-button" disabled={!embedSnippet} onClick={() => void copy(embedSnippet)}>Copy code</button>
            {formUrl && <><p><strong>Public form URL:</strong> <a href={formUrl} target="_blank" rel="noreferrer">{formUrl}</a></p><iframe className="embed-live-preview" src={formUrl} title="Preview embedded complaint form" loading="lazy" /></>}
            {!formUrl && activeFormId && <p className="contact-privacy-note">The current public token is stored as a hash and is not shown again. Existing installed code remains valid. <button className="text-button" onClick={() => { const form = forms.find((item) => item.id === activeFormId); if (form) void rotateForm(form); }}>Rotate this form to show a replacement URL</button></p>}
            <ol className="embed-checklist"><li>Confirm your website origin is in the form’s allowlist.</li><li>Open the page locally or on your website and submit a test complaint.</li><li>Confirm the complaint appears in this workspace’s Complaints page.</li><li>Verify a replay with the same idempotency key does not create another complaint.</li></ol>
            <button className="text-button" onClick={() => setStep(1)}>Back to form configuration</button>
          </div>}
          {forms.length > 0 && <div className="embed-existing-forms"><h2>Your embed forms</h2><ul className="integration-list">{forms.map((form) => <li key={form.id}><div><strong>{form.display_name}</strong><small>{form.enabled && !form.revoked_at ? "Enabled" : "Revoked"} · Allowed origins: {form.allowed_origins.length || "none"}</small></div><div className="integration-actions">{!form.revoked_at && <button className="filter-button" disabled={saving} onClick={() => { if (activeFormId !== form.id) setFormUrl(""); setActiveFormId(form.id); setEditingFormId(form.id); setFormName(form.display_name); setFields(form.fields); setOrigins(form.allowed_origins.join("\n")); setOption("embed"); setStep(1); }}>Edit settings</button>}<button className="filter-button" disabled={saving} onClick={() => void rotateForm(form)}>Rotate URL</button>{!form.revoked_at && <button className="filter-button danger-button" disabled={saving} onClick={() => void revokeForm(form)}>Revoke</button>}</div></li>)}</ul></div>}
        </section> : <section className="workspace-panel embed-step"><div className="embed-step-indicator"><span aria-current={connectStep === 1 ? "step" : undefined}>1 · Choose credential</span><span aria-current={connectStep === 2 ? "step" : undefined}>2 · Add server code</span></div>
          {connectStep === 1 ? <><h2>Use a server-side credential</h2><p>Select an active credential or create one. The API credential belongs only on your server. Browser HTML and React examples below call your own backend, never NomaanOS with the secret.</p>
            <label>Existing credential<select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}><option value="">Choose an active credential</option>{credentials.filter((item) => !item.revoked_at && (!item.expires_at || Date.parse(item.expires_at) > Date.now())).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.key_prefix}</option>)}</select></label>
            <form className="integration-create-form" onSubmit={(event) => void createCredential(event)}><label>Or create a credential<input value={credentialName} onChange={(event) => setCredentialName(event.target.value)} required maxLength={100} /></label><button className="filter-button" disabled={saving}>{saving ? "Creating…" : "Create API credential"}</button></form>
            {oneTimeSecret && <section className="workspace-panel one-time-secret" aria-label="One-time API credential"><strong>Copy this API credential now</strong><code>{oneTimeSecret}</code><button className="filter-button" onClick={() => void copy(oneTimeSecret)}>Copy credential</button><button className="text-button" onClick={() => setOneTimeSecret("")}>Hide credential</button><p>The secret is shown once by the existing credential API. Store it in a server-side secret manager. It is never inserted in the generated browser code.</p></section>}
            <div className="embed-security-note"><strong>Keep the secret on your server</strong><p>Never put a Bearer credential in HTML, browser JavaScript, a React client component, a NEXT_PUBLIC_ variable, or a public repository. If exposed, revoke and rotate it in Integrations.</p></div>
            <button className="filter-button" disabled={!credentialId} onClick={() => setConnectStep(2)}>Continue to code examples</button>
          </> : <><div className="embed-security-note"><strong>Keep the secret on your server</strong><p>Store the credential in a server-side environment variable or secret manager. Do not put it in HTML, browser JavaScript, React client code, or NEXT_PUBLIC_ values.</p></div>
            <div className="embed-tabs" role="tablist" aria-label="Backend code technology">{technologies.map((item) => <button key={item} role="tab" aria-selected={technology === item} onClick={() => setTechnology(item)}>{item}</button>)}</div>
            <p>{technology === "HTML + JavaScript" || technology === "React" ? "Put the form in your page and implement /api/submit-complaint on your backend. Validate the request and forward it using the server credential." : technology === "Next.js" ? "Put the form component in your app and add the Route Handler at app/api/complaints/route.ts. Add the two server-only variables to .env.local and your production secret store." : "Run this request from a trusted server or serverless function over HTTPS."}</p>
            <pre className="integration-code"><code>{existingSnippet}</code></pre><button className="filter-button" onClick={() => void copy(existingSnippet)}>Copy code</button>
            <h3>Check the connection</h3><ul className="embed-checklist"><li>Valid submission returns 201 and a complaint receipt.</li><li>Invalid fields return 400; missing, invalid, expired, or revoked credentials return 401.</li><li>Repeat the same payload and Idempotency-Key: 200 replay. Reuse that key with changed data: 409.</li><li>Workspace ingestion rate limit returns 429 with Retry-After; disabled integration returns 403.</li><li>Network or API failures should show a generic message and can be retried with the same key.</li><li>Confirm the complaint appears only in the credential’s workspace.</li></ul>
            <p className="contact-privacy-note">There is no “test credential” button because the API has no safe credential-validation endpoint. A real submission is the supported check; use a clearly labeled test complaint.</p><button className="text-button" onClick={() => setConnectStep(1)}>Back to credential selection</button>
          </>}
        </section>}
      </>}
    </section>
  </main>;
}