"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiErrorMessage, apiRequest } from "../../../lib/api";

type Complaint = {
  id: string;
  title: string;
  description: string;
  customer_email: string | null;
  source: string;
  status: string;
  created_at: string;
  updated_at: string;
  analysis_status?: "pending" | "processing" | "completed" | "failed" | null;
  analysis_error?: string | null;
  analysis_model_name?: string | null;
};
type Workspace = { id: string; name: string; role: "owner" | "admin" | "member" };
type Analysis = {
  category: string; sentiment: string; severity: string; priority_score: number; priority_label: string;
  reasoning_summary: string; suggested_reply: string; model_name: string; analyzed_at: string;
};
type AnalysisJob = {
  status: "pending" | "processing" | "completed" | "failed";
  error: string | null;
};

function formatModelName(model: string) {
  if (model.startsWith("gpt-") || model.includes("openai")) return `OpenAI (${model})`;
  if (model.startsWith("gemini")) return `Google Gemini (${model})`;
  if (model.startsWith("ollama-")) return `Ollama (${model.replace(/^ollama-/, "")})`;
  if (model === "nomaan-keyword-baseline-v1") return "Keyword Baseline";
  return model;
}
type ActivityEvent = {
  id: string; event_type: "complaint_created" | "status_changed" | "analysis_completed" | "social_message_received";
  actor_user_id: string; actor_name: string | null; occurred_at: string;
  metadata: { previous_status?: string; new_status?: string; provider?: string };
  social_message?: string | null;
};
const statuses = ["open", "in_progress", "resolved", "closed"];

function activityTitle(event: ActivityEvent) {
  if (event.event_type === "complaint_created") return "Complaint created";
  if (event.event_type === "status_changed") return "Status changed";
  if (event.event_type === "social_message_received") return `${event.metadata.provider === "whatsapp" ? "WhatsApp" : "Instagram"} message received`;
  return "Complaint analysis completed";
}

export default function ComplaintDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisJob, setAnalysisJob] = useState<AnalysisJob | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState("");
  const [replyDraft, setReplyDraft] = useState("");
  const [error, setError] = useState("");
  const [analysisError, setAnalysisError] = useState("");
  const [busy, setBusy] = useState(true);
  const [analysisLoading, setAnalysisLoading] = useState(true);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const me = await apiRequest<{ user: { id: string } }>("/auth/me");
      if (me.response.status === 401) { router.replace("/login"); return; }
      if (!me.response.ok) throw new Error("Could not load your account.");
      const listed = await apiRequest<{ workspaces: Workspace[] }>("/workspaces");
      if (!listed.response.ok) throw new Error(apiErrorMessage(listed.data, "Could not load workspaces."));
      const requestedId = new URLSearchParams(window.location.search).get("workspaceId");
      const active = listed.data.workspaces.find((item) => item.id === requestedId);
      if (!active) throw new Error("Workspace or complaint not found.");
      const detail = await apiRequest<{ complaint?: Complaint; error?: string }>(`/workspaces/${active.id}/complaints/${params.id}`);
      if (detail.response.status === 401) { router.replace("/login"); return; }
      if (!detail.response.ok || !detail.data.complaint) throw new Error(apiErrorMessage(detail.data, "Workspace or complaint not found."));
      if (cancelled) return;
      setWorkspace(active); setComplaint(detail.data.complaint);
      const saved = await apiRequest<{ analysis: Analysis | null; job?: AnalysisJob | null; error?: string }>(`/workspaces/${active.id}/complaints/${params.id}/analysis`);
      if (saved.response.status === 401) { router.replace("/login"); return; }
      if (!saved.response.ok) {
        setAnalysisError(apiErrorMessage(saved.data, "Could not load saved analysis."));
      } else {
        setAnalysis(saved.data.analysis);
        if (saved.data.job) setAnalysisJob(saved.data.job);
        setReplyDraft(saved.data.analysis?.suggested_reply ?? "");
      }
      try {
        const timeline = await apiRequest<{ events: ActivityEvent[]; pagination: { nextCursor: string | null }; error?: string }>(`/workspaces/${active.id}/complaints/${params.id}/activity?limit=20`);
        if (timeline.response.status === 401) { router.replace("/login"); return; }
        if (!timeline.response.ok) setActivityError(apiErrorMessage(timeline.data, "Could not load complaint activity."));
        else {
          setActivity(timeline.data.events);
          setActivityCursor(timeline.data.pagination.nextCursor);
          setActivityHasMore(Boolean(timeline.data.pagination.nextCursor));
        }
      } catch {
        if (!cancelled) setActivityError("Could not load complaint activity.");
      } finally {
        if (!cancelled) setActivityLoading(false);
      }
    }
    load().catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load complaint."); })
      .finally(() => { if (!cancelled) { setBusy(false); setAnalysisLoading(false); } });
    return () => { cancelled = true; };
  }, [params.id, router]);

  useEffect(() => {
    if (!workspace || !complaint || analysis) return;
    const isJobActive = analysisJob?.status === "pending" || analysisJob?.status === "processing" ||
      complaint.analysis_status === "pending" || complaint.analysis_status === "processing";
    if (!isJobActive) return;

    const interval = setInterval(() => {
      apiRequest<{ analysis: Analysis | null; job?: AnalysisJob | null; error?: string }>(
        `/workspaces/${workspace.id}/complaints/${complaint.id}/analysis`
      ).then(({ data, response }) => {
        if (response.ok) {
          if (data.analysis) {
            setAnalysis(data.analysis);
            setReplyDraft(data.analysis.suggested_reply);
            setAnalysisJob({ status: "completed", error: null });
            void refreshActivity(workspace.id, complaint.id);
          } else if (data.job) {
            setAnalysisJob(data.job);
          }
        }
      }).catch(() => { /* silent poll */ });
    }, 3000);

    return () => clearInterval(interval);
  }, [workspace, complaint, analysis, analysisJob]);

  async function refreshActivity(workspaceId: string, complaintId: string) {
    setActivityLoading(true); setActivityError("");
    try {
      const timeline = await apiRequest<{ events: ActivityEvent[]; pagination: { nextCursor: string | null }; error?: string }>(`/workspaces/${workspaceId}/complaints/${complaintId}/activity?limit=20`);
      if (timeline.response.status === 401) { router.replace("/login"); return; }
      if (!timeline.response.ok) { setActivityError(apiErrorMessage(timeline.data, "Could not load complaint activity.")); return; }
      setActivity(timeline.data.events);
      setActivityCursor(timeline.data.pagination.nextCursor);
      setActivityHasMore(Boolean(timeline.data.pagination.nextCursor));
    } catch {
      setActivityError("Could not load complaint activity.");
    } finally {
      setActivityLoading(false);
    }
  }

  async function loadMoreActivity() {
    if (!workspace || !complaint || !activityCursor || activityLoading) return;
    setActivityLoading(true); setActivityError("");
    try {
      const timeline = await apiRequest<{ events: ActivityEvent[]; pagination: { nextCursor: string | null }; error?: string }>(`/workspaces/${workspace.id}/complaints/${complaint.id}/activity?limit=20&cursor=${encodeURIComponent(activityCursor)}`);
      if (timeline.response.status === 401) { router.replace("/login"); return; }
      if (!timeline.response.ok) { setActivityError(apiErrorMessage(timeline.data, "Could not load more complaint activity.")); return; }
      setActivity((current) => [...current, ...timeline.data.events]);
      setActivityCursor(timeline.data.pagination.nextCursor);
      setActivityHasMore(Boolean(timeline.data.pagination.nextCursor));
    } catch {
      setActivityError("Could not load more complaint activity.");
    } finally {
      setActivityLoading(false);
    }
  }

  async function updateStatus(status: string) {
    if (!workspace || !complaint) return;
    const { data, response } = await apiRequest<{ complaint?: Complaint; error?: string }>(`/workspaces/${workspace.id}/complaints/${complaint.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    if (response.status === 401) { router.replace("/login"); return; }
    if (!response.ok || !data.complaint) { setError(apiErrorMessage(data, "Could not update complaint status.")); return; }
    setComplaint(data.complaint); setError("");
    await refreshActivity(workspace.id, complaint.id);
  }

  async function runAnalysis() {
    if (!workspace || !complaint || analysisBusy) return;
    setAnalysisBusy(true); setAnalysisError(""); setCopied(false);
    try {
      const { data, response } = await apiRequest<{ analysis?: Analysis; error?: string }>(`/workspaces/${workspace.id}/complaints/${complaint.id}/analysis`, { method: "POST", body: JSON.stringify({}) });
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok || !data.analysis) throw new Error(apiErrorMessage(data, "Could not analyze complaint. You can retry manually."));
      setAnalysis(data.analysis); setReplyDraft(data.analysis.suggested_reply);
      setAnalysisJob({ status: "completed", error: null });
      await refreshActivity(workspace.id, complaint.id);
    } catch (caught) {
      setAnalysisError(caught instanceof Error ? caught.message : "Could not analyze complaint. You can retry manually.");
      setAnalysisJob({ status: "failed", error: caught instanceof Error ? caught.message : "Analysis failed" });
    } finally { setAnalysisBusy(false); }
  }

  async function copyReply() {
    try { await navigator.clipboard.writeText(replyDraft); setCopied(true); }
    catch { setAnalysisError("Could not copy the draft. You can select and copy it manually."); }
  }

  const isCritical = analysis?.priority_label?.toLowerCase() === 'high' || analysis?.priority_label?.toLowerCase() === 'critical' || (analysis?.priority_score && analysis.priority_score >= 75);

  return <main className="dashboard-shell complaints-shell">
    <nav className="topbar"><Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link><Link className="text-button" href={workspace ? `/complaints?workspace=${workspace.id}` : "/complaints"}>Back to complaints</Link></nav>
    {busy ? <p className="loading-state">Loading complaint…</p> : <section className="dashboard-content" style={{ maxWidth: '900px' }}>
      <p className="eyebrow">COMPLAINT DETAIL{workspace ? ` · ${workspace.name.toUpperCase()}` : ""}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      
      {complaint && <>
        <article className="workspace-panel detail-panel">
          <div className="panel-head">
            <h1>{complaint.title}</h1>
            {workspace && workspace.role !== "member" ? (
              <label className="detail-status">Status
                <select value={complaint.status} onChange={(event) => void updateStatus(event.target.value)}>
                  {statuses.map((item) => <option key={item} value={item}>{item.replace("_", " ")}</option>)}
                </select>
              </label>
            ) : (
              <span className={`complaint-status status-${complaint.status}`}>{complaint.status.replace("_", " ")}</span>
            )}
          </div>

          {isCritical && (
            <div className="critical-alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
              <span>Critical Issue: This complaint requires immediate attention due to high priority/severity.</span>
            </div>
          )}

          <p className="detail-description">{complaint.description}</p>
          
          <dl className="detail-meta-grid">
            <div className="detail-meta-item"><dt>Source</dt><dd>{complaint.source}</dd></div>
            <div className="detail-meta-item"><dt>Customer email</dt><dd>{complaint.customer_email ?? "Not provided"}</dd></div>
            <div className="detail-meta-item"><dt>Created</dt><dd>{new Date(complaint.created_at).toLocaleString()}</dd></div>
            <div className="detail-meta-item"><dt>Last Updated</dt><dd>{new Date(complaint.updated_at).toLocaleString()}</dd></div>
          </dl>
        </article>

        <section className="workspace-panel activity-panel" aria-labelledby="activity-heading">
          <div className="panel-head">
            <div><p className="eyebrow">HISTORY</p><h2 id="activity-heading">Activity timeline</h2></div>
          </div>
          {activityError && <p className="form-error" role="alert">{activityError}</p>}
          {activityLoading && activity.length === 0 ? <p className="loading-state">Loading activity…</p> : activity.length === 0 ? <p className="empty-state">No recorded activity yet.</p> : <>
            <ol className="activity-timeline">
              {activity.map((event) => <li className="activity-event" key={event.id}>
                <div className="activity-event-heading"><strong>{activityTitle(event)}</strong><time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString()}</time></div>
                {event.event_type === "status_changed" && <p>{event.metadata.previous_status?.replace("_", " ") ?? "Unknown"} → {event.metadata.new_status?.replace("_", " ") ?? "Unknown"}</p>}
                {event.event_type === "social_message_received" && event.social_message && <p className="social-message-body">{event.social_message}</p>}
                <small>{event.actor_name ? `By ${event.actor_name}` : "System activity"}</small>
              </li>)}
            </ol>
            {activityHasMore && <button className="filter-button" type="button" onClick={() => void loadMoreActivity()} disabled={activityLoading}>{activityLoading ? "Loading…" : "Load more activity"}</button>}
          </>}
        </section>

        <section className="workspace-panel analysis-panel">
          <div className="panel-head">
            <div><p className="eyebrow">AI INTELLIGENCE</p><h2>Analysis & Suggested Reply</h2></div>
            <button className="primary-link" onClick={() => void runAnalysis()} disabled={analysisBusy || analysisLoading}>
              {analysisBusy ? "Analysing…" : analysis ? "Re-analyse" : "Analyse complaint"}
            </button>
          </div>

          {analysisError && <p className="form-error" role="alert">{analysisError}</p>}
          {analysisLoading ? <p className="loading-state">Loading saved analysis…</p> : !analysis ? (
            analysisJob?.status === "processing" || complaint?.analysis_status === "processing" ? (
              <div className="analysis-status-card" style={{ padding: '16px', background: 'var(--panel-subtle, rgba(255,255,255,0.03))', borderRadius: '8px' }}>
                <span className="complaint-status status-in_progress" style={{ marginBottom: '8px', display: 'inline-block' }}>⚙️ Analyzing…</span>
                <p>An AI model is analyzing this complaint in the background. Results will appear automatically.</p>
              </div>
            ) : analysisJob?.status === "pending" || complaint?.analysis_status === "pending" ? (
              <div className="analysis-status-card" style={{ padding: '16px', background: 'var(--panel-subtle, rgba(255,255,255,0.03))', borderRadius: '8px' }}>
                <span className="complaint-status" style={{ marginBottom: '8px', display: 'inline-block' }}>⏳ Analysis queued</span>
                <p>This complaint is queued for automatic AI analysis. Checking for results…</p>
              </div>
            ) : (analysisJob?.status === "failed" || complaint?.analysis_status === "failed") ? (
              <div className="analysis-status-card" style={{ padding: '16px', background: 'var(--panel-subtle, rgba(255,255,255,0.03))', borderRadius: '8px', borderLeft: '3px solid var(--danger, #ef4444)' }}>
                <span className="complaint-status status-closed" style={{ marginBottom: '8px', display: 'inline-block' }}>⚠️ Analysis failed</span>
                <p>{analysisJob?.error || complaint?.analysis_error || "Analysis encountered a provider error."} Click “Analyse complaint” above to retry.</p>
              </div>
            ) : (
              <p className="empty-state">This complaint has not been analysed yet. Choose “Analyse complaint” above to generate an AI analysis.</p>
            )
          ) : <>
            
            <div className="analysis-status">
              <span className="complaint-status status-resolved" style={{ background: 'var(--accent-soft)', color: 'var(--accent-hover)' }}>Analysis Ready</span>
              <span>Analyzed {new Date(analysis.analyzed_at).toLocaleString()}</span>
              <span>Provider: {formatModelName(analysis.model_name)}</span>
            </div>

            {analysis.model_name === "nomaan-keyword-baseline-v1" && <p className="analysis-notice" style={{ marginBottom: '20px' }}>Deterministic keyword baseline; heuristic scores are not scientifically validated and are not an LLM prediction.</p>}
            
            <dl className="analysis-grid">
              <div><dt>Category</dt><dd>{analysis.category.replace("_", " ")}</dd></div>
              <div><dt>Sentiment</dt><dd>{analysis.sentiment}</dd></div>
              <div><dt>Severity</dt><dd style={{ color: isCritical ? 'var(--danger)' : 'inherit' }}>{analysis.severity}</dd></div>
              <div><dt>Priority</dt><dd style={{ color: isCritical ? 'var(--danger)' : 'inherit' }}>{analysis.priority_label} · {analysis.priority_score}/100</dd></div>
            </dl>

            <div className="analysis-summary">
              <h3>Reasoning Summary</h3>
              <p>{analysis.reasoning_summary}</p>
            </div>

            <div className="suggested-reply">
              <label htmlFor="suggested-reply">Suggested reply draft <small>Edit before use; this is never sent automatically.</small></label>
              <textarea id="suggested-reply" value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)} maxLength={1200} rows={5} />
              <button className="filter-button" type="button" onClick={() => void copyReply()}>{copied ? "Copied" : "Copy draft"}</button>
            </div>
          </>}
        </section>
      </>}
    </section>}
  </main>;
}