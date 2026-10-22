export type Technology = "HTML + JavaScript" | "React" | "Next.js" | "Generic backend";

export function sourceFor(technology: Technology) {
  if (technology === "HTML + JavaScript") return `<!-- Place this form in your page. It sends submissions to YOUR server, never directly to NomaanOS. -->
<form id="complaint-form">
  <label>Complaint title <input name="title" required maxlength="200"></label>
  <label>Description <textarea name="description" required maxlength="10000"></textarea></label>
  <label>Email (optional) <input name="customer_email" type="email" maxlength="254"></label>
  <button type="submit">Send complaint</button>
  <p id="form-status" role="status"></p>
</form>
<script>
let idempotencyKey = crypto.randomUUID();
document.querySelector('#complaint-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget, status = document.querySelector('#form-status');
  const button = form.querySelector('button'); button.disabled = true; status.textContent = 'Sending…';
  try {
    const payload = Object.fromEntries(new FormData(form));
    if (!String(payload.customer_email || '').trim()) delete payload.customer_email;
    const response = await fetch('/api/submit-complaint', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Submission failed.');
    status.textContent = 'Your complaint was received.'; form.reset(); idempotencyKey = crypto.randomUUID();
  } catch (error) { status.textContent = error.message || 'Could not send. Please try again.'; }
  finally { button.disabled = false; }
});
</script>

Create /api/submit-complaint on your server. That route must validate fields and call NomaanOS with its server-side credential.`;
  if (technology === "React") return `// ComplaintForm.jsx — client-side UI only. Your server must provide /api/submit-complaint.
import { useRef, useState } from 'react';

export function ComplaintForm() {
  const [form, setForm] = useState({ title: '', description: '', customer_email: '' });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  async function submit(event) {
    event.preventDefault(); setBusy(true); setStatus('Sending…');
    try {
      const payload = { title: form.title, description: form.description, ...(form.customer_email.trim() ? { customer_email: form.customer_email.trim() } : {}) };
      const response = await fetch('/api/submit-complaint', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey.current }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Submission failed.');
      setStatus('Your complaint was received.'); setForm({ title: '', description: '', customer_email: '' }); idempotencyKey.current = crypto.randomUUID();
    } catch (error) { setStatus(error.message || 'Could not send. Please try again.'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit}>
    <label>Complaint title<input required maxLength={200} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
    <label>Description<textarea required maxLength={10000} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
    <label>Email (optional)<input type="email" maxLength={254} value={form.customer_email} onChange={e => setForm({ ...form, customer_email: e.target.value })} /></label>
    <button disabled={busy}>{busy ? 'Sending…' : 'Send complaint'}</button><p role="status">{status}</p>
  </form>;
}

Keep the NomaanOS API credential in your backend environment, never in this component.`;
  if (technology === "Next.js") return `// app/components/ComplaintForm.tsx — client-side form
'use client';
import { useRef, useState } from 'react';

export function ComplaintForm() {
  const [form, setForm] = useState({ title: '', description: '', customer_email: '' });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setStatus('Sending…');
    try {
      const payload = { title: form.title, description: form.description, ...(form.customer_email.trim() ? { customer_email: form.customer_email.trim() } : {}) };
      const response = await fetch('/api/complaints', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey.current }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Submission failed.');
      setStatus('Your complaint was received.'); setForm({ title: '', description: '', customer_email: '' }); idempotencyKey.current = crypto.randomUUID();
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not send.'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit}>
    <label>Complaint title<input required maxLength={200} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
    <label>Description<textarea required maxLength={10000} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
    <label>Email (optional)<input type="email" maxLength={254} value={form.customer_email} onChange={e => setForm({ ...form, customer_email: e.target.value })} /></label>
    <button disabled={busy}>{busy ? 'Sending…' : 'Send complaint'}</button><p role="status">{status}</p>
  </form>;
}

// app/api/complaints/route.ts — server-side Route Handler
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const incomingKey = request.headers.get('idempotency-key');
  if (!incomingKey || !/^[\\x21-\\x7e]{1,128}$/.test(incomingKey)) return NextResponse.json({ error: 'Invalid request key.' }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const input = body as Record<string, unknown>;
  const emailValue = typeof input.customer_email === 'string' ? input.customer_email.trim().toLowerCase() : undefined;
  const email = emailValue || undefined;
  if (Object.keys(input).some(k => !['title', 'description', 'customer_email'].includes(k)) ||
      typeof input.title !== 'string' || typeof input.description !== 'string' ||
      (input.customer_email !== undefined && typeof input.customer_email !== 'string') ||
      !input.title.trim() || input.title.trim().length > 200 || !input.description.trim() || input.description.trim().length > 10000 ||
      (email !== undefined && (email.length > 254 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)))) {
    return NextResponse.json({ error: 'Enter a title and description.' }, { status: 400 });
  }
  const credential = process.env.NOMAANOS_API_CREDENTIAL;
  const base = process.env.NOMAANOS_API_URL;
  if (!credential || !base) return NextResponse.json({ error: 'Complaint service is not configured.' }, { status: 503 });
  try {
    const upstream = await fetch(new URL('/api/v1/integrations/complaints', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json', 'idempotency-key': incomingKey },
      body: JSON.stringify({ title: input.title.trim(), description: input.description.trim(), customer_email: email })
    });
    const result = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const retryAfter = upstream.status === 429 ? upstream.headers.get('retry-after') : null;
      return NextResponse.json(
        { error: upstream.status === 429 ? 'Please wait and retry.' : 'NomaanOS could not accept this complaint.' },
        { status: upstream.status, headers: retryAfter ? { 'retry-after': retryAfter } : undefined }
      );
    }
    return NextResponse.json(result, { status: upstream.status });
  } catch { return NextResponse.json({ error: 'Complaint service is temporarily unavailable.' }, { status: 502 }); }
}

// Put NOMAANOS_API_URL and NOMAANOS_API_CREDENTIAL in .env.local on the server only.
// Never prefix the credential with NEXT_PUBLIC_.`;
  return `// Server-side Node.js example. Keep both values in your server secret manager.
const response = await fetch(new URL('/api/v1/integrations/complaints', process.env.NOMAANOS_API_URL), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
  headers: {
    authorization: 'Bearer ' + process.env.NOMAANOS_API_CREDENTIAL,
    'content-type': 'application/json',
    'idempotency-key': 'support-ticket/REPLACE_WITH_STABLE_TICKET_ID'
  },
  body: JSON.stringify({
    title: ticket.subject,
    description: ticket.description,
    customer_email: ticket.customerEmail
  })
});
if (response.status === 409) throw new Error('The request key was reused with different data.');
if (response.status === 429) throw new Error('Rate limited; retry after ' + response.headers.get('retry-after') + ' seconds.');
if (!response.ok) throw new Error('NomaanOS request failed: ' + response.status);
const result = await response.json(); // { complaint: { id, status, createdAt } }`;
}

export function embedSnippetFor(url: string, technology: Technology) {
  if (technology === "HTML + JavaScript") return `<iframe src="${url}" title="Submit a complaint" width="100%" height="650" style="border:0;width:100%;max-width:720px" loading="lazy"></iframe>`;
  if (technology === "React") return `export function NomaanComplaintEmbed() {\n  return <iframe src="${url}" title="Submit a complaint" style={{ width: '100%', minHeight: 650, border: 0 }} />;\n}`;
  return `// In a Next.js page or component\nexport function NomaanComplaintEmbed() {\n  return <iframe src="${url}" title="Submit a complaint" style={{ width: '100%', minHeight: 650, border: 0 }} />;\n}`;
}
