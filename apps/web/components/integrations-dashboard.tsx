"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";
import { parseWhatsAppSignupMessage, type WhatsAppSignupAssets } from "../lib/meta-whatsapp-signup";
import { PublicContactFormHelp } from "./public-contact-form-help";

declare global {
  interface Window {
    FB?: {
      init: (options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
      login: (
        callback: (response: { authResponse?: { code?: string } | null }) => void,
        options: { config_id: string; response_type: "code"; override_default_response_type: boolean; extras: { setup: Record<string, never> } }
      ) => void;
    };
  }
}

type Workspace = { id: string; name: string; role: "owner" | "admin" | "member" };
type Credential = { id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; rotated_to: string | null };
type Webhook = { id: string; url: string; event_types: string[]; enabled: boolean; created_at: string; updated_at: string };
type Delivery = { id: string; endpoint_id: string; url: string; event_id: string; state: string; attempt_count: number; total_attempt_count: number; next_attempt_at: string; delivered_at: string | null; last_attempt_at: string | null; last_http_status: number | null; last_result: string | null; created_at: string; attempt_history_count: number };
type ContactFormConfig = { id: string; enabled: boolean; created_at: string; updated_at: string; revoked_at: string | null };
type InboundRoute = { id: string; inboundAddress: string | null; enabled: boolean; created_at: string; updated_at: string; revoked_at: string | null };
type InboundEvent = { status: string; error_code: string | null; attempt_count: number; next_attempt_at: string; received_at: string; processed_at: string | null; attachment_metadata: Array<{ filename: string; contentType: string; size: number; status: string }> };
type MetaSocialConnection = { id: string; provider: "whatsapp" | "instagram"; provider_account_id: string; business_account_id: string | null; display_name: string; status: "pending" | "active" | "disconnected"; created_at: string; updated_at: string; last_successful_event_at: string | null; last_error_code: string | null; connected_at?: string | null; access_token_expires_at?: string | null; phone_display_number?: string | null; phone_verified_name?: string | null; authorized?: boolean };
type WhatsAppConfiguration = { ready: boolean; missing: string[]; appId: string | null; loginConfigId: string | null; graphApiVersion: string };
type StatusVariant = "ready" | "setup-required" | "not-configured" | "coming-soon" | "revoked";

function StatusBadge({ label, variant }: { label: string; variant: StatusVariant }) {
  return <span className={`integration-status-badge status-badge-${variant}`}>{label}</span>;
}

const supportedEvents = ["complaint_created", "status_changed", "analysis_completed"];
const emptyDraft = { url: "", eventTypes: ["complaint_created"], enabled: true };
let facebookSdkPromise: Promise<void> | null = null;
let initializedMetaSdk: string | null = null;

export function IntegrationsDashboard() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [settings, setSettings] = useState({ enabled: true, requests_per_minute: 60 });
  const [contactForm, setContactForm] = useState<ContactFormConfig | null>(null);
  const [contactFormBaseUrl, setContactFormBaseUrl] = useState("");
  const [generatedContactFormUrl, setGeneratedContactFormUrl] = useState<{ workspaceId: string; url: string } | null>(null);
  const [inboundRoute, setInboundRoute] = useState<InboundRoute | null>(null);
  const [inboundStatus, setInboundStatus] = useState("not_configured");
  const [inboundEvents, setInboundEvents] = useState<InboundEvent[]>([]);
  const [metaConnections, setMetaConnections] = useState<MetaSocialConnection[]>([]);
  const [metaCallbackUrl, setMetaCallbackUrl] = useState<string | null>(null);
  const [metaConfiguration, setMetaConfiguration] = useState({ appSecretConfigured: false, verificationTokenConfigured: false });
  const [whatsAppConfiguration, setWhatsAppConfiguration] = useState<WhatsAppConfiguration>({ ready: false, missing: [], appId: null, loginConfigId: null, graphApiVersion: "v26.0" });
  const [metaDraft, setMetaDraft] = useState({ providerAccountId: "", displayName: "" });
  const [name, setName] = useState("");
  const [expires, setExpires] = useState("");
  const [draft, setDraft] = useState(emptyDraft);
  const [webhookDrafts, setWebhookDrafts] = useState<Record<string, { url: string; eventTypes: string[]; enabled: boolean }>>({});
  const [secret, setSecret] = useState("");
  const [secretKind, setSecretKind] = useState("");
  const [busy, setBusy] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    apiRequest<{ workspaces: Workspace[] }>("/workspaces").then(({ data, response }) => {
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not load workspaces."));
      setWorkspaces(data.workspaces);
      const requested = new URLSearchParams(window.location.search).get("workspaceId");
      setWorkspaceId(data.workspaces.some((item) => item.id === requested) ? requested! : data.workspaces[0]?.id ?? "");
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load workspaces."))
      .finally(() => setBusy(false));
  }, [router]);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true); setError("");
    try {
      const base = `/workspaces/${workspaceId}/integrations`;
      const results = await Promise.all([
        apiRequest<{ credentials: Credential[] }>(`${base}/credentials`),
        apiRequest<{ webhooks: Webhook[] }>(`${base}/webhooks`),
        apiRequest<{ deliveries: Delivery[] }>(`${base}/deliveries?limit=20`),
        apiRequest<{ settings: typeof settings }>(`${base}/settings`),
        apiRequest<{ form: ContactFormConfig | null; hostedFormBaseUrl: string }>(`${base}/contact-form`),
        apiRequest<{ route: InboundRoute | null; status: string }>(`${base}/inbound-email`),
        apiRequest<{ events: InboundEvent[] }>(`${base}/inbound-email/events?limit=10`),
        apiRequest<{ connections: MetaSocialConnection[]; callbackUrl: string | null; configuration: typeof metaConfiguration }>(`${base}/meta-social`),
        apiRequest<WhatsAppConfiguration>(`${base}/whatsapp/config`)
      ]);
      const failed = results.find((result) => !result.response.ok);
      if (failed) {
        if (failed.response.status === 401) { router.replace("/login"); return; }
        throw new Error(apiErrorMessage(failed.data, failed.response.status === 403 ? "Integration settings are available to workspace owners and admins." : "Could not load integration settings."));
      }
      setCredentials(results[0].data.credentials); setWebhooks(results[1].data.webhooks); setDeliveries(results[2].data.deliveries); setSettings(results[3].data.settings);
      setContactForm(results[4].data.form); setContactFormBaseUrl(results[4].data.hostedFormBaseUrl);
      setInboundRoute(results[5].data.route); setInboundStatus(results[5].data.status); setInboundEvents(results[6].data.events);
      setMetaConnections(results[7].data.connections); setMetaCallbackUrl(results[7].data.callbackUrl); setMetaConfiguration(results[7].data.configuration);
      setWhatsAppConfiguration(results[8].data);
      setWebhookDrafts(Object.fromEntries(results[1].data.webhooks.map((item) => [item.id, { url: item.url, eventTypes: item.event_types, enabled: item.enabled }])));
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load integration settings."); }
    finally { setLoading(false); }
  }, [workspaceId, router]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const { data, response } = await apiRequest<{ settings?: typeof settings; error?: string }>(`/workspaces/${workspaceId}/integrations/settings`, {
        method: "PATCH", body: JSON.stringify({ enabled: settings.enabled, requestsPerMinute: settings.requests_per_minute })
      });
      if (!response.ok || !data.settings) setError(apiErrorMessage(data, "Could not save integration settings."));
      else { setSettings(data.settings); setNotice("Workspace integration settings saved."); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save integration settings."); }
    finally { setSaving(false); }
  }

  async function createCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const body: Record<string, string> = { name };
      if (expires) body.expiresAt = new Date(`${expires}T23:59:59.000Z`).toISOString();
      const { data, response } = await apiRequest<{ secret?: string; error?: string }>(`/workspaces/${workspaceId}/integrations/credentials`, { method: "POST", body: JSON.stringify(body) });
      if (!response.ok || !data.secret) setError(apiErrorMessage(data, "Could not create integration credential."));
      else { setSecret(data.secret); setSecretKind("API credential"); setName(""); setExpires(""); setNotice("The credential was created. Copy it now; it will not be shown again."); await refresh(); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create integration credential."); }
    finally { setSaving(false); }
  }

  async function createWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const { data, response } = await apiRequest<{ signingSecret?: string; error?: string }>(`/workspaces/${workspaceId}/integrations/webhooks`, {
        method: "POST", body: JSON.stringify({ url: draft.url, eventTypes: draft.eventTypes })
      });
      if (!response.ok || !data.signingSecret) setError(apiErrorMessage(data, "Could not create webhook endpoint."));
      else { setSecret(data.signingSecret); setSecretKind("Webhook signing secret"); setDraft(emptyDraft); setNotice("Webhook created. Copy the signing secret now; it will not be shown again."); await refresh(); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create webhook endpoint."); }
    finally { setSaving(false); }
  }

  async function saveMetaConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const { data, response } = await apiRequest<{ error?: string }>(`/workspaces/${workspaceId}/integrations/meta-social`, {
        method: "POST",
        body: JSON.stringify({
          provider: "instagram",
          providerAccountId: metaDraft.providerAccountId.trim(),
          displayName: metaDraft.displayName.trim()
        })
      });
      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not configure this Meta account."));
      setMetaDraft({ providerAccountId: "", displayName: "" });
      setNotice("Meta account configuration saved. It remains pending until a valid signed webhook message arrives.");
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not configure this Meta account."); }
    finally { setSaving(false); }
  }

  async function disconnectMeta(connection: MetaSocialConnection) {
    if (!window.confirm(`Disconnect ${connection.display_name}? New messages will no longer create complaints.`)) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const { data, response } = await apiRequest<{ error?: string }>(`/workspaces/${workspaceId}/integrations/meta-social/${connection.id}/disconnect`, {
        method: "POST", body: "{}"
      });
      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not disconnect this Meta account."));
      setNotice("Meta account disconnected. New messages for it will no longer create complaints.");
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not disconnect this Meta account."); }
    finally { setSaving(false); }
  }

  async function loadFacebookSdk(appId: string, version: string) {
    if (!window.FB) {
      facebookSdkPromise ??= new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.id = "facebook-jssdk";
        script.src = "https://connect.facebook.net/en_US/sdk.js";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
          script.remove();
          facebookSdkPromise = null;
          reject(new Error("Could not load Meta's signup SDK. Check the browser connection and try again."));
        };
        document.body.appendChild(script);
      });
      await facebookSdkPromise;
    }
    if (!window.FB) throw new Error("Meta's signup SDK did not initialize.");
    const sdkConfig = `${appId}:${version}`;
    if (initializedMetaSdk !== sdkConfig) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      initializedMetaSdk = sdkConfig;
    }
    return window.FB;
  }

  async function connectWhatsApp() {
    if (!whatsAppConfiguration.appId || !whatsAppConfiguration.loginConfigId) {
      setError("WhatsApp Embedded Signup is not configured on this server.");
      return;
    }
    setSaving(true); setError(""); setNotice("");
    try {
      const facebook = await loadFacebookSdk(whatsAppConfiguration.appId, whatsAppConfiguration.graphApiVersion);
      const { data: stateData, response: stateResponse } = await apiRequest<{ state?: string; error?: string }>(
        `/workspaces/${workspaceId}/integrations/whatsapp/onboarding`,
        { method: "POST", body: "{}" }
      );
      if (!stateResponse.ok || !stateData.state) {
        throw new Error(apiErrorMessage(stateData, "Could not securely start WhatsApp signup."));
      }
      const { code, assets } = await new Promise<{ code: string; assets: WhatsAppSignupAssets }>((resolve, reject) => {
        let code: string | undefined;
        let assets: WhatsAppSignupAssets | undefined;
        let settled = false;
        const cleanup = () => {
          window.removeEventListener("message", onMessage);
          window.clearTimeout(timeout);
        };
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(message));
        };
        const finishIfReady = () => {
          if (!settled && code && assets) {
            settled = true;
            cleanup();
            resolve({ code, assets });
          }
        };
        const onMessage = (event: MessageEvent) => {
          const message = parseWhatsAppSignupMessage(event.origin, event.data);
          if (!message) return;
          if (message.event === "CANCEL") { fail("WhatsApp signup was cancelled."); return; }
          if (message.event === "ERROR") { fail("Meta could not complete WhatsApp signup."); return; }
          if (message.event !== "FINISH") return;
          assets = message.assets;
          finishIfReady();
        };
        const timeout = window.setTimeout(() => fail("WhatsApp signup timed out. Start again when ready."), 120_000);
        window.addEventListener("message", onMessage);
        try {
          facebook.login((response) => {
            const receivedCode = response.authResponse?.code;
            if (typeof receivedCode !== "string" || !receivedCode || receivedCode.length > 4096) {
              fail("Meta did not return an authorization code. Start WhatsApp signup again.");
              return;
            }
            code = receivedCode;
            finishIfReady();
          }, {
            config_id: whatsAppConfiguration.loginConfigId!,
            response_type: "code",
            override_default_response_type: true,
            extras: { setup: {} }
          });
        } catch {
          fail("Meta signup could not be opened. Check the Facebook Login for Business configuration.");
        }
      });
      const { data, response } = await apiRequest<{ error?: string; connection?: MetaSocialConnection }>(
        `/workspaces/${workspaceId}/integrations/whatsapp/complete`,
        {
          method: "POST",
          body: JSON.stringify({ state: stateData.state, code, phoneNumberId: assets.phoneNumberId, wabaId: assets.wabaId })
        }
      );
      if (!response.ok || !data.connection) {
        throw new Error(apiErrorMessage(data, "Meta could not connect this WhatsApp account."));
      }
      setNotice("WhatsApp is connected. New messages will be added to this workspace after Meta delivers them.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not connect WhatsApp.");
    } finally {
      setSaving(false);
    }
  }

  async function action(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown, oneTimeKind?: string, oneTimeValue?: (data: Record<string, any>) => string) {
    setSaving(true); setError(""); setNotice("");
    try {
      const { data, response } = await apiRequest<{ secret?: string; signingSecret?: string; error?: string }>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) setError(apiErrorMessage(data, "The integration action failed."));
      else {
        const oneTimeSecret = oneTimeValue?.(data) ?? data.secret ?? data.signingSecret;
        if (oneTimeKind === "Public hosted form URL" && oneTimeSecret) {
          setGeneratedContactFormUrl({ workspaceId, url: oneTimeSecret });
        }
        if (oneTimeSecret) { setSecret(oneTimeSecret); setSecretKind(oneTimeKind ?? "Secret"); setNotice("Copy this secret now; it will not be shown again."); }
        else setNotice(method === "DELETE" ? "Webhook endpoint deleted." : "Integration updated.");
        await refresh();
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The integration action failed."); }
    finally { setSaving(false); }
  }

  async function logout() { await apiRequest("/auth/logout", { method: "POST", body: "{}" }); router.replace("/login"); }

  return <main className="dashboard-shell integrations-shell">
    <nav className="topbar"><Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link><div className="complaint-nav"><Link className="text-button" href="/dashboard">Dashboard</Link><Link className="text-button" href="/analytics">Analytics</Link><Link className="text-button" href="/complaints">Complaints</Link><button className="text-button" onClick={() => void logout()}>Log out</button></div></nav>
    {busy ? <p className="loading-state">Loading integration settings…</p> : <section className="dashboard-content">
      <p className="eyebrow">INTEGRATION SETTINGS</p><h1>Connect your systems</h1><p className="dashboard-intro">Manage workspace API credentials, event subscriptions, and delivery history.</p>
      {workspaces.length > 0 && <div className="complaint-toolbar"><label>Workspace<select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setSecret(""); setGeneratedContactFormUrl(null); setNotice(""); }}><option value="" disabled>Select workspace</option>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><button className="filter-button" disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></div>}
      {error && <div className="analytics-error" role="alert"><p>{error}</p><button className="filter-button" onClick={() => void refresh()}>Retry</button></div>}
      {notice && <p className="integration-notice" role="status">{notice}</p>}
      {secret && <section className="workspace-panel one-time-secret" aria-label="One-time secret"><div><strong>{secretKind}</strong><p>Store this securely. NomaanOS will not display it again.</p></div><code>{secret}</code><button className="filter-button" onClick={() => { void navigator.clipboard.writeText(secret).then(() => setNotice("Copied to clipboard. Clear the clipboard after storing the secret securely.")); }}>Copy secret</button><button className="text-button" onClick={() => setSecret("")}>Hide secret</button></section>}
      {workspaces.length === 0 ? <section className="workspace-panel"><p className="empty-state">Create a workspace from the <Link href="/dashboard">dashboard</Link> before configuring integrations.</p></section> : workspaceId && !loading && !error && <>
        <section className="workspace-panel integrations-settings"><div className="panel-head"><h2>Ingestion settings</h2><span>Workspace shared limit</span></div><form onSubmit={(event) => void saveSettings(event)}><label className="integration-check"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /> Allow API credential ingestion</label><label>Requests per minute<input type="number" min={1} max={600} value={settings.requests_per_minute} onChange={(event) => setSettings((current) => ({ ...current, requests_per_minute: Number(event.target.value) }))} /></label><button className="filter-button" disabled={saving}>Save settings</button></form><p>Only workspace owners and admins can change this limit. It is enforced in PostgreSQL across API processes.</p></section>
        <section className="workspace-panel integration-section"><div className="panel-head"><div className="contact-form-heading"><h2>Public contact form</h2><PublicContactFormHelp formUrl={contactForm?.enabled && !contactForm.revoked_at && generatedContactFormUrl?.workspaceId === workspaceId ? generatedContactFormUrl.url : undefined} /></div><StatusBadge label={contactForm?.revoked_at ? "Revoked" : contactForm?.enabled ? "Ready" : "Not configured"} variant={contactForm?.revoked_at ? "revoked" : contactForm?.enabled ? "ready" : "not-configured"} /></div><p>Hosted by NomaanOS. The public token maps to this workspace server-side. Never use a workspace API credential in browser code.</p>{contactForm ? <div className="integration-actions"><button className="filter-button" disabled={saving} onClick={() => void action(`/workspaces/${workspaceId}/integrations/contact-form/rotate`, "POST", {}, "Public hosted form URL", (data) => `${contactFormBaseUrl}/${data.token}`)}>Rotate form link</button><button className="filter-button" disabled={saving} onClick={() => void action(`/workspaces/${workspaceId}/integrations/contact-form`, "PATCH", { enabled: !contactForm.enabled })}>{contactForm.enabled ? "Disable" : "Enable"} form</button></div> : <button className="filter-button" disabled={saving} onClick={() => void action(`/workspaces/${workspaceId}/integrations/contact-form`, "POST", {}, "Public hosted form URL", (data) => `${contactFormBaseUrl}/${data.token}`)}>Create contact form link</button>}</section>
        <section className="workspace-panel integration-section"><div className="panel-head"><h2>Embed &amp; Integrate Form</h2><StatusBadge label="Ready" variant="ready" /></div><p>Embed a ready-made complaint form, or connect a form on your site through your own secure backend.</p><Link className="filter-button" href={`/integrations/embed?workspaceId=${encodeURIComponent(workspaceId)}`}>Open setup wizard</Link></section>
        <section className="workspace-panel integration-section">
          <div className="panel-head">
            <h2>WhatsApp and Instagram</h2>
            <StatusBadge label="Coming Soon" variant="coming-soon" />
          </div>
          <div className="coming-soon-card">
            <span className="coming-soon-pill">Feature in Development</span>
            <h3>Omnichannel Messaging Integrations</h3>
            <p>
              Direct customer complaint ingestion via WhatsApp Cloud API and Instagram Direct Messaging is coming in an upcoming release. Automated message syncing, sentiment classification, and unified agent replies will be available soon.
            </p>
            <div className="coming-soon-tags">
              <span>✦ WhatsApp Cloud API</span>
              <span>✦ Instagram Direct Messages</span>
              <span>✦ Verified Channel Webhooks</span>
            </div>
          </div>
        </section>

        <section className="workspace-panel integration-section">
          <div className="panel-head">
            <h2>Inbound email</h2>
            <StatusBadge label="Coming Soon" variant="coming-soon" />
          </div>
          <div className="coming-soon-card">
            <span className="coming-soon-pill">Feature in Development</span>
            <h3>Automated Email Ingestion</h3>
            <p>
              Forward incoming customer emails to a dedicated workspace address to automatically create and categorize complaints. Inbound routing and verified mailbox integrations are currently being finalized.
            </p>
            <div className="coming-soon-tags">
              <span>✦ Dedicated Support Address</span>
              <span>✦ Inbound MX Routing</span>
              <span>✦ Attachment Metadata Extraction</span>
            </div>
          </div>
        </section>

        <section className="workspace-panel integration-section">
          <div className="panel-head">
            <h2>API credentials</h2>
            <StatusBadge label={`${credentials.length} configured`} variant={credentials.length > 0 ? "ready" : "not-configured"} />
          </div>
          <form className="integration-create-form" onSubmit={(event) => void createCredential(event)}>
            <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} placeholder="Website contact form" /></label>
            <label>Expires on <small>Optional</small><input type="date" value={expires} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setExpires(event.target.value)} /></label>
            <button className="filter-button" disabled={saving}>Create credential</button>
          </form>
          {credentials.length ? <ul className="integration-list">{credentials.map((item) => <li key={item.id}><div><strong>{item.name}</strong><small>Prefix <code>{item.key_prefix}</code> · Created {new Date(item.created_at).toLocaleString()}</small><small>{item.last_used_at ? `Last used ${new Date(item.last_used_at).toLocaleString()}` : "Never used"}{item.expires_at ? ` · Expires ${new Date(item.expires_at).toLocaleDateString()}` : " · No expiry"}{item.revoked_at ? ` · Revoked ${new Date(item.revoked_at).toLocaleString()}` : ""}</small></div>{!item.revoked_at && <div className="integration-actions"><button className="filter-button" disabled={saving} onClick={() => void action(`/workspaces/${workspaceId}/integrations/credentials/${item.id}/rotate`, "POST", {}, "Replacement API credential")}>Rotate</button><button className="filter-button danger-button" disabled={saving} onClick={() => void action(`/workspaces/${workspaceId}/integrations/credentials/${item.id}/revoke`, "POST", {})}>Revoke</button></div>}</li>)}</ul> : <p className="empty-state">No API credentials yet.</p>}
        </section>

        <section className="workspace-panel integration-section">
          <div className="panel-head">
            <h2>Webhook endpoints</h2>
            <StatusBadge label="Coming Soon" variant="coming-soon" />
          </div>
          <div className="coming-soon-card">
            <span className="coming-soon-pill">Feature in Development</span>
            <h3>Outbound Event Webhooks</h3>
            <p>
              Subscribe your external backend and systems to real-time complaint lifecycle events, classification updates, and SLA alerts. Webhook subscriptions and delivery logging will be available in an upcoming release.
            </p>
            <div className="coming-soon-tags">
              <span>✦ Real-Time Event Dispatch</span>
              <span>✦ HMAC-SHA256 Signatures</span>
              <span>✦ Automated Retries &amp; Deliveries</span>
            </div>
          </div>
        </section>
      </>}
    </section>}
  </main>;
}

function EventChoices({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  return <fieldset className="integration-events"><legend>Events</legend>{supportedEvents.map((eventType) => <label key={eventType}><input type="checkbox" checked={values.includes(eventType)} onChange={(event) => onChange(event.target.checked ? [...values, eventType] : values.filter((item) => item !== eventType))} />{eventType.replaceAll("_", " ")}</label>)}</fieldset>;
}