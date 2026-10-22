"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";

type Workspace = { id: string; name: string; role: string };
type Distribution = { label?: string; category?: string; count: number };
type Overview = {
  dateRange: { startDate: string; endDate: string; timezone: string };
  totalComplaints: number;
  statusCounts: { open: number; in_progress: number; resolved: number; closed: number };
  unresolvedCount: number;
  resolutionRate: number | null;
  averageResolutionTimeHours: number | null;
  resolutionTimeSampleSize: number;
  categories: Distribution[];
  priorities: Distribution[];
  severities: Distribution[];
  trends: { date: string; count: number }[];
};

function utcDate(date: Date) { return date.toISOString().slice(0, 10); }
function label(value: string) { return value.replaceAll("_", " "); }

export function AnalyticsDashboard() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [appliedRange, setAppliedRange] = useState({ startDate: "", endDate: "" });
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const today = new Date();
    const end = utcDate(today);
    const start = utcDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29)));
    setStartDate(start); setEndDate(end); setAppliedRange({ startDate: start, endDate: end });
    apiRequest<{ workspaces: Workspace[] }>("/workspaces").then(({ data, response }) => {
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not load your workspaces."));
      setWorkspaces(data.workspaces);
      const requested = new URLSearchParams(window.location.search).get("workspaceId");
      setWorkspaceId(data.workspaces.some((workspace) => workspace.id === requested) ? requested! : data.workspaces[0]?.id ?? "");
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load your workspaces."))
      .finally(() => setBusy(false));
  }, [router]);

  const loadOverview = useCallback(async (id: string, range: { startDate: string; endDate: string }) => {
    if (!id) { setOverview(null); return; }
    setLoading(true); setError("");
    const query = new URLSearchParams(range);
    try {
      const { data, response } = await apiRequest<Overview & { error?: string }>(`/workspaces/${id}/analytics/overview?${query}`);
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) throw new Error(apiErrorMessage(data, "Could not load workspace analytics."));
      setOverview(data); setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load workspace analytics.");
    } finally { setLoading(false); }
  }, [router]);

  useEffect(() => { if (workspaceId && appliedRange.startDate && appliedRange.endDate) void loadOverview(workspaceId, appliedRange); }, [workspaceId, appliedRange, loadOverview]);

  function applyFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOverview(null);
    setAppliedRange({ startDate, endDate });
  }

  const maxTrend = Math.max(1, ...(overview?.trends.map((item) => item.count) ?? [1]));
  const points = overview?.trends.map((item, index) => {
    const x = overview.trends.length < 2 ? 300 : 12 + (index * 576) / (overview.trends.length - 1);
    const y = 154 - (item.count / maxTrend) * 136;
    return `${x},${y}`;
  }).join(" ") ?? "";

  return <main className="dashboard-shell analytics-shell">
    <nav className="topbar"><Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link><div className="complaint-nav"><Link className="text-button" href="/dashboard">Dashboard</Link><Link className="text-button" href={workspaceId ? `/complaints?workspace=${workspaceId}` : "/complaints"}>Complaints</Link><Link className="text-button" href={workspaceId ? `/integrations?workspaceId=${workspaceId}` : "/integrations"}>Integrations</Link><button className="text-button" onClick={async () => { await apiRequest("/auth/logout", { method: "POST", body: "{}" }); router.replace("/login"); }}>Log out</button></div></nav>
    {busy ? <p className="loading-state">Loading your analytics…</p> : <section className="dashboard-content">
      <p className="eyebrow">WORKSPACE INSIGHTS</p><h1>Analytics</h1><p className="dashboard-intro">Complaint volume, status, and AI analysis for your workspace.</p>
      {workspaces.length > 0 && <div className="analytics-controls"><label>Workspace<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label><form onSubmit={applyFilters}><label>From<input type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} required /></label><label>Through<input type="date" value={endDate} min={startDate || undefined} max={utcDate(new Date())} onChange={(event) => setEndDate(event.target.value)} required /></label><button className="filter-button" disabled={loading}>Apply dates</button></form></div>}
      {error && <div className="analytics-error" role="alert"><p>{error}</p>{workspaceId && <button className="filter-button" onClick={() => void loadOverview(workspaceId, appliedRange)}>Retry</button>}</div>}
      {workspaces.length === 0 ? <section className="workspace-panel"><p className="empty-state">No workspace is available for your account. Create one from the <Link href="/dashboard">dashboard</Link>.</p></section> : loading ? <p className="loading-state" aria-live="polite">Loading analytics…</p> : overview && <>
        <p className="analytics-range">Showing {overview.dateRange.startDate} through {overview.dateRange.endDate} (UTC)</p>
        {overview.totalComplaints === 0 ? <section className="workspace-panel analytics-empty"><h2>No complaints in this date range</h2><p>Try a wider date range or record a complaint.</p><Link className="primary-link" href={`/complaints?workspace=${workspaceId}`}>Open complaints <span>↗</span></Link></section> : <>
          <section className="analytics-kpis" aria-label="Complaint summary">
            <article className="analytics-kpi"><span>Total complaints</span><strong>{overview.totalComplaints}</strong></article>
            <article className="analytics-kpi"><span>Unresolved</span><strong>{overview.unresolvedCount}</strong><small>{overview.statusCounts.open} open · {overview.statusCounts.in_progress} in progress</small></article>
            <article className="analytics-kpi"><span>Resolution rate</span><strong>{overview.resolutionRate === null ? "—" : `${overview.resolutionRate}%`}</strong><small>Resolved or closed / all complaints</small></article>
            <article className="analytics-kpi"><span>Average resolution</span><strong>{overview.averageResolutionTimeHours === null ? "—" : `${overview.averageResolutionTimeHours.toFixed(1)}h`}</strong><small>{overview.averageResolutionTimeHours === null ? "No complete activity history" : `Based on ${overview.resolutionTimeSampleSize} tracked complaints`}</small></article>
          </section>
          <section className="analytics-grid">
            <article className="workspace-panel analytics-chart"><div className="panel-head"><h2>Complaint trend</h2><span>Created per day</span></div><svg className="trend-chart" viewBox="0 0 600 180" role="img" aria-label="Daily complaint counts in selected date range"><line x1="12" y1="154" x2="588" y2="154" /><polyline points={points} /><circle cx={points.split(" ").at(-1)?.split(",")[0] ?? "300"} cy={points.split(" ").at(-1)?.split(",")[1] ?? "154"} r="4" /></svg><div className="trend-axis"><span>{overview.trends[0]?.date}</span><span>{overview.trends.at(-1)?.date}</span></div></article>
            <article className="workspace-panel analytics-chart"><div className="panel-head"><h2>Status</h2><span>Current</span></div><DistributionBars values={Object.entries(overview.statusCounts).map(([name, count]) => ({ label: name, count }))} /></article>
            <article className="workspace-panel analytics-chart"><div className="panel-head"><h2>Categories</h2><span>AI analyzed</span></div>{overview.categories.length ? <DistributionBars values={overview.categories.map((item) => ({ label: item.category!, count: item.count }))} /> : <p className="analytics-note">AI analysis is unavailable for this date range. Run analysis on complaint records to see categories.</p>}</article>
            <article className="workspace-panel analytics-chart"><div className="panel-head"><h2>Priority</h2><span>AI analyzed</span></div>{overview.priorities.length ? <DistributionBars values={overview.priorities.map((item) => ({ label: item.label!, count: item.count }))} /> : <p className="analytics-note">No AI priority results are available for this date range.</p>}<h3 className="analytics-subhead">Severity</h3>{overview.severities.length ? <DistributionBars values={overview.severities.map((item) => ({ label: item.label!, count: item.count }))} /> : <p className="analytics-note">No severity results are available.</p>}</article>
          </section>
        </>}
      </>}
    </section>}
  </main>;
}

function DistributionBars({ values }: { values: { label: string; count: number }[] }) {
  const max = Math.max(1, ...values.map((item) => item.count));
  return <ul className="analytics-bars">{values.map((item) => <li key={item.label}><div><span>{label(item.label)}</span><strong>{item.count}</strong></div><span className="analytics-bar-track"><span style={{ width: `${Math.max(item.count ? 4 : 0, (item.count / max) * 100)}%` }} /></span></li>)}</ul>;
}