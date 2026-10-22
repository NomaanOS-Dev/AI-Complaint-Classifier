"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";

type Workspace = { id: string; name: string; role: "owner" | "admin" | "member" };
type Complaint = { id: string; title: string; description: string; customer_name?: string | null; customer_email: string | null; submitted_category?: string | null; source: string; status: string; created_at: string; analysis_category?: string | null; analysis_priority_label?: string | null; analysis_priority_score?: number | null; analysis_analyzed_at?: string | null };
const statuses = ["open", "in_progress", "resolved", "closed"];

export function ComplaintManagement() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest<{ user: { id: string } }>("/auth/me").then(async (me) => {
      if (me.response.status === 401) { router.replace("/login"); return; }
      if (!me.response.ok) throw new Error("Could not load your account.");
      const result = await apiRequest<{ workspaces: Workspace[] }>("/workspaces");
      if (!result.response.ok) throw new Error(apiErrorMessage(result.data, "Could not load workspaces."));
      setWorkspaces(result.data.workspaces);
      const requestedId = new URLSearchParams(window.location.search).get("workspace");
      setWorkspaceId(result.data.workspaces.some((item) => item.id === requestedId) ? requestedId! : result.data.workspaces[0]?.id ?? "");
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load complaints."))
      .finally(() => setBusy(false));
  }, [router]);

  useEffect(() => {
    if (!workspaceId) { setComplaints([]); return; }
    let cancelled = false;
    setListLoading(true);
    const params = new URLSearchParams({ limit: "20", offset: String(offset) });
    if (statusFilter) params.set("status", statusFilter);
    if (search) params.set("q", search);
    apiRequest<{ complaints: Complaint[]; pagination: { hasMore: boolean } }>(`/workspaces/${workspaceId}/complaints?${params}`)
      .then(({ data, response }) => {
        if (cancelled) return;
        if (response.status === 401) { router.replace("/login"); return; }
        if (!response.ok) throw new Error(apiErrorMessage(data, "Could not load complaints."));
        setComplaints(data.complaints); setHasMore(data.pagination.hasMore); setError(""); setListLoading(false);
      }).catch((caught: unknown) => { if (!cancelled) { setError(caught instanceof Error ? caught.message : "Could not load complaints."); setListLoading(false); } });
    return () => { cancelled = true; };
  }, [workspaceId, offset, statusFilter, search, router]);

  async function createComplaint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!workspaceId || saving) return;
    setSaving(true); setError("");
    try {
      const { data, response } = await apiRequest<{ complaint?: Complaint; error?: string }>(`/workspaces/${workspaceId}/complaints`, {
        method: "POST", body: JSON.stringify({ title, description, customer_email: customerEmail || undefined, source: "manual" })
      });
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok || !data.complaint) throw new Error(apiErrorMessage(data, "Could not create complaint."));
      setTitle(""); setDescription(""); setCustomerEmail(""); setSearch(""); setSearchInput(""); setStatusFilter(""); setOffset(0);
      if (offset !== 0 || statusFilter || search) return;
      setComplaints((current) => [data.complaint!, ...current].slice(0, 20));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create complaint."); }
    finally { setSaving(false); }
  }

  async function changeStatus(complaint: Complaint, nextStatus: string) {
    const { data, response } = await apiRequest<{ complaint?: Complaint; error?: string }>(`/workspaces/${workspaceId}/complaints/${complaint.id}/status`, {
      method: "PATCH", body: JSON.stringify({ status: nextStatus })
    });
    if (response.status === 401) { router.replace("/login"); return; }
    if (!response.ok || !data.complaint) { setError(apiErrorMessage(data, "Could not update complaint status.")); return; }
    setComplaints((current) => current.map((item) => item.id === complaint.id ? data.complaint! : item));
  }

  const activeWorkspace = workspaces.find((item) => item.id === workspaceId);
  return <main className="dashboard-shell complaints-shell">
    <nav className="topbar"><Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link><div className="complaint-nav"><Link className="text-button" href="/dashboard">Dashboard</Link><button className="text-button" onClick={async () => { await apiRequest("/auth/logout", { method: "POST", body: "{}" }); router.replace("/login"); }}>Log out</button></div></nav>
    {busy ? <p className="loading-state">Loading your complaints…</p> : <section className="dashboard-content">
      <p className="eyebrow">COMPLAINT WORKSPACE</p><h1>Complaints</h1><p className="dashboard-intro">Capture and track customer issues for a workspace you belong to.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {workspaces.length === 0 ? <section className="workspace-panel"><p className="empty-state">You do not have an authorized workspace yet. Create one from the <Link href="/dashboard">dashboard</Link>.</p></section> : <>
        <div className="complaint-toolbar"><label>Active workspace<select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setOffset(0); const url = new URL(window.location.href); url.searchParams.set("workspace", event.target.value); window.history.replaceState({}, "", url); }}>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><span>Signed in workspace members can create and read complaints.</span></div>
        <div className="complaint-layout"><section className="workspace-panel complaint-form-panel"><p className="eyebrow">NEW ENTRY</p><h2>Record a complaint</h2><form onSubmit={createComplaint}><label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} required minLength={1} maxLength={200} /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} required minLength={1} maxLength={10000} rows={5} /></label><label>Customer email <small>Optional</small><input type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} maxLength={254} /></label><button className="primary-link form-submit" disabled={saving}>{saving ? "Saving…" : "Create complaint"}</button></form></section>
          <section className="workspace-panel complaint-list-panel"><div className="panel-head"><h2>Complaint records</h2><span>{activeWorkspace?.name}</span></div><div className="complaint-filters"><form onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(searchInput.trim()); }}><label className="visually-hidden" htmlFor="complaint-search">Search complaints</label><input id="complaint-search" placeholder="Search title or description" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} /><button className="filter-button">Search</button></form><label className="visually-hidden" htmlFor="complaint-status">Filter by status</label><select id="complaint-status" value={statusFilter} onChange={(event) => { setOffset(0); setStatusFilter(event.target.value); }}><option value="">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{item.replace("_", " ")}</option>)}</select></div>
            {listLoading ? <p className="loading-state">Loading complaints…</p> : complaints.length ? <div className="complaint-table">{complaints.map((item) => <article className="complaint-row" key={item.id}><div className="complaint-copy"><Link href={`/complaints/${item.id}?workspaceId=${workspaceId}`}><strong>{item.title}</strong></Link><small>{item.source} · {new Date(item.created_at).toLocaleString()}</small>{(item.customer_name || item.customer_email) && <small>{item.customer_name ? `${item.customer_name} · ` : ""}{item.customer_email ?? "No customer email"}{item.submitted_category ? ` · ${item.submitted_category.replace("_", " ")}` : ""}</small>}<small>{item.analysis_category ? `Analysis: ${item.analysis_category.replace("_", " ")} · ${item.analysis_priority_label} ${item.analysis_priority_score}/100 · ${item.analysis_analyzed_at ? new Date(item.analysis_analyzed_at).toLocaleString() : ""}` : "Not analysed"}</small></div>{activeWorkspace && activeWorkspace.role !== "member" ? <select aria-label={`Status for ${item.title}`} value={item.status} onChange={(event) => void changeStatus(item, event.target.value)}>{statuses.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select> : <span className={`complaint-status status-${item.status}`}>{item.status.replace("_", " ")}</span>}</article>)}</div> : <p className="empty-state">No complaints match this view. Create a record or change your filters.</p>}
            <div className="pagination"><button className="filter-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</button><span>Page {Math.floor(offset / 20) + 1}</span><button className="filter-button" disabled={!hasMore} onClick={() => setOffset(offset + 20)}>Next</button></div>
          </section></div>
      </>}
    </section>}
  </main>;
}