"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";
import { TwoLayerNavbar } from "./brand-logo";
import { AnimatedCounter, Reveal, SkeletonGrid } from "./motion-primitives";

type User = { id: string; name: string; email: string; email_verified?: boolean };
type Workspace = { id: string; name: string; role: "owner" | "admin" | "member"; created_at?: string };
type Overview = {
  totalComplaints: number;
  statusCounts: { open: number; in_progress: number; resolved: number; closed: number };
  unresolvedCount: number;
  resolutionRate: number | null;
  averageResolutionTimeHours: number | null;
  categories: Array<{ category?: string; count: number }>;
  priorities: Array<{ label?: string; count: number }>;
};
type ComplaintSummary = {
  id: string;
  title: string;
  source: string;
  status: string;
  created_at: string;
  customer_email: string | null;
  analysis_category?: string | null;
  analysis_priority_label?: string | null;
  analysis_priority_score?: number | null;
  analysis_status?: "pending" | "processing" | "completed" | "failed" | null;
};

function labelize(value: string) {
  return value.replaceAll("_", " ");
}

export function WorkspaceDashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [recentComplaints, setRecentComplaints] = useState<ComplaintSummary[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const loadWorkspaceSummary = useCallback(async (workspaceId: string) => {
    if (!workspaceId) {
      setOverview(null);
      setRecentComplaints([]);
      return;
    }
    setMetricsLoading(true);
    try {
      const [overviewRes, complaintsRes] = await Promise.all([
        apiRequest<Overview>(`/workspaces/${workspaceId}/analytics/overview`),
        apiRequest<{ complaints: ComplaintSummary[] }>(`/workspaces/${workspaceId}/complaints?limit=5&offset=0`)
      ]);
      if (overviewRes.response.ok) {
        setOverview(overviewRes.data);
      }
      if (complaintsRes.response.ok) {
        setRecentComplaints(complaintsRes.data.complaints ?? []);
      }
    } catch {
      // Non-fatal: workspace list remains usable even if summary metrics fail to load.
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  async function load() {
    const me = await apiRequest<{ user: User }>("/auth/me");
    if (me.response.status === 401) {
      router.replace("/login");
      return;
    }
    if (!me.response.ok) throw new Error("Could not load your account.");
    if (me.data.user && me.data.user.email_verified === false) {
      router.replace("/verify-email");
      return;
    }
    const list = await apiRequest<{ workspaces: Workspace[] }>("/workspaces");
    if (!list.response.ok) throw new Error(apiErrorMessage(list.data, "Could not load workspaces."));
    setUser(me.data.user);
    setWorkspaces(list.data.workspaces);
    const firstId = list.data.workspaces[0]?.id ?? "";
    setActiveWorkspaceId(firstId);
    if (firstId) {
      await loadWorkspaceSummary(firstId);
    }
  }

  useEffect(() => {
    load()
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load your account."))
      .finally(() => setBusy(false));
  }, []);

  async function selectWorkspace(id: string) {
    setActiveWorkspaceId(id);
    await loadWorkspaceSummary(id);
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const { data, response } = await apiRequest<{ workspace?: Workspace; error?: string }>("/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: workspaceName })
    });
    if (!response.ok || !data.workspace) {
      setError(apiErrorMessage(data, "Could not create workspace."));
      return;
    }
    setWorkspaces((current) => [...current, data.workspace!]);
    setWorkspaceName("");
    if (!activeWorkspaceId) {
      await selectWorkspace(data.workspace.id);
    }
  }

  async function logout() {
    await apiRequest("/auth/logout", { method: "POST", body: JSON.stringify({}) });
    router.replace("/login");
  }

  const activeWorkspace = workspaces.find((item) => item.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  const maxCategory = Math.max(1, ...(overview?.categories.map((c) => c.count) ?? [1]));

  return (
    <main className="dashboard-shell">
      <TwoLayerNavbar>
        <Link className="text-button" href={activeWorkspace ? `/complaints?workspace=${activeWorkspace.id}` : "/complaints"}>
          Complaints
        </Link>
        <Link className="text-button" href={activeWorkspace ? `/analytics?workspaceId=${activeWorkspace.id}` : "/analytics"}>
          Analytics
        </Link>
        <Link className="text-button" href={activeWorkspace ? `/integrations?workspaceId=${activeWorkspace.id}` : "/integrations"}>
          Integrations
        </Link>
        <Link className="text-button" href={activeWorkspace ? `/billing?workspaceId=${activeWorkspace.id}` : "/billing"}>
          Billing
        </Link>
        <Link className="text-button" href="/pricing">Pricing</Link>
        <Link className="text-button" href="/docs">Docs</Link>
        <button className="text-button" onClick={logout}>Log out</button>
      </TwoLayerNavbar>

      {busy ? (
        <p className="loading-state">Loading your workspace…</p>
      ) : (
        <section className="dashboard-content">
          <div className="dash-header-row">
            <div>
              <p className="eyebrow">WORKSPACE OVERVIEW</p>
              <h1>Welcome, {user?.name ?? "there"}.</h1>
              <p className="dashboard-intro">
                Monitor complaint volume, triage urgent customer issues, and manage your team workspaces.
              </p>
            </div>
            {activeWorkspace && (
              <div className="dash-actions">
                {workspaces.length > 1 && (
                  <label className="dash-ws-select">
                    <span className="visually-hidden">Active workspace</span>
                    <select value={activeWorkspace.id} onChange={(e) => void selectWorkspace(e.target.value)}>
                      {workspaces.map((ws) => (
                        <option key={ws.id} value={ws.id}>
                          {ws.name} ({ws.role})
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <Link className="primary-link" href={`/complaints?workspace=${activeWorkspace.id}`}>
                  + Record complaint
                </Link>
                <Link className="filter-button" href={`/analytics?workspaceId=${activeWorkspace.id}`}>
                  Analytics
                </Link>
                {activeWorkspace.role !== "member" && (
                  <Link className="filter-button" href={`/integrations?workspaceId=${activeWorkspace.id}`}>
                    Public forms
                  </Link>
                )}
              </div>
            )}
          </div>

          {error && <p className="form-error" role="alert">{error}</p>}

          {activeWorkspace && (
            <>
              <section className="analytics-kpis dash-kpis" aria-label="30-day workspace summary">
                <article className="analytics-kpi interactive-card">
                  <span>Complaints (30 days)</span>
                  <strong>{metricsLoading && !overview ? "—" : <AnimatedCounter value={overview?.totalComplaints ?? 0} />}</strong>
                  <small>{activeWorkspace.name}</small>
                </article>
                <article className="analytics-kpi interactive-card">
                  <span>Unresolved queue</span>
                  <strong>{metricsLoading && !overview ? "—" : <AnimatedCounter value={overview?.unresolvedCount ?? 0} />}</strong>
                  <small>
                    {overview ? `${overview.statusCounts.open} open · ${overview.statusCounts.in_progress} in progress` : "Open & active"}
                  </small>
                </article>
                <article className="analytics-kpi interactive-card">
                  <span>Resolution rate</span>
                  <strong>
                    {overview?.resolutionRate === null || overview?.resolutionRate === undefined ? (
                      "—"
                    ) : (
                      <AnimatedCounter value={overview.resolutionRate} suffix="%" />
                    )}
                  </strong>
                  <small>Resolved or closed in last 30 days</small>
                </article>
                <article className="analytics-kpi interactive-card">
                  <span>Avg. resolution time</span>
                  <strong>
                    {overview?.averageResolutionTimeHours === null || overview?.averageResolutionTimeHours === undefined ? (
                      "—"
                    ) : (
                      <AnimatedCounter value={overview.averageResolutionTimeHours} decimals={1} suffix="h" />
                    )}
                  </strong>
                  <small>From arrival to resolution</small>
                </article>
              </section>

              <section className="dash-main-grid">
                <article className="workspace-panel">
                  <div className="panel-head">
                    <h2>Recent complaints</h2>
                    <Link className="workspace-arrow" href={`/complaints?workspace=${activeWorkspace.id}`}>
                      View all ↗
                    </Link>
                  </div>
                  {metricsLoading && recentComplaints.length === 0 ? (
                    <p className="loading-state" style={{ padding: "24px 0" }}>Loading recent complaints…</p>
                  ) : recentComplaints.length === 0 ? (
                    <div className="dash-empty-box">
                      <p>No complaints recorded in <strong>{activeWorkspace.name}</strong> yet.</p>
                      <div className="dash-empty-actions">
                        <Link className="primary-link" href={`/complaints?workspace=${activeWorkspace.id}`}>
                          Create first complaint ↗
                        </Link>
                        {activeWorkspace.role !== "member" && (
                          <Link className="filter-button" href={`/integrations?workspaceId=${activeWorkspace.id}`}>
                            Set up public form
                          </Link>
                        )}
                      </div>
                    </div>
                  ) : (
                    <ul className="dash-recent-list">
                      {recentComplaints.map((item) => {
                        const urgent =
                          item.analysis_priority_label === "urgent" ||
                          item.analysis_priority_label === "high" ||
                          (item.analysis_priority_score ?? 0) >= 75;
                        return (
                          <li key={item.id} className="dash-recent-item">
                            <div className="dash-recent-copy">
                              <Link href={`/complaints/${item.id}?workspaceId=${activeWorkspace.id}`}>
                                <strong>{item.title}</strong>
                              </Link>
                              <small>
                                {labelize(item.source)} · {new Date(item.created_at).toLocaleDateString()}
                                {item.customer_email ? ` · ${item.customer_email}` : ""}
                              </small>
                              <small>
                                {item.analysis_category ? (
                                  <span className={urgent ? "dash-priority-urgent" : undefined}>
                                    {labelize(item.analysis_category)} · {item.analysis_priority_label} ({item.analysis_priority_score}/100)
                                  </span>
                                ) : item.analysis_status === "processing" ? (
                                  "Analyzing…"
                                ) : item.analysis_status === "pending" ? (
                                  "Analysis queued"
                                ) : item.analysis_status === "failed" ? (
                                  "Analysis needs retry"
                                ) : (
                                  "Not analysed"
                                )}
                              </small>
                            </div>
                            <span className={`complaint-status status-${item.status}`}>{labelize(item.status)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </article>

                <div className="dash-side-stack">
                  <article className="workspace-panel">
                    <div className="panel-head">
                      <h2>Top AI categories</h2>
                      <Link className="workspace-arrow" href={`/analytics?workspaceId=${activeWorkspace.id}`}>
                        Full report ↗
                      </Link>
                    </div>
                    {overview && overview.categories.length > 0 ? (
                      <ul className="analytics-bars">
                        {overview.categories.slice(0, 5).map((cat) => (
                          <li key={cat.category ?? "other"}>
                            <div>
                              <span>{labelize(cat.category ?? "other")}</span>
                              <strong>{cat.count}</strong>
                            </div>
                            <span className="analytics-bar-track">
                              <span style={{ width: `${Math.max(6, (cat.count / maxCategory) * 100)}%` }} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="empty-state" style={{ padding: "12px 0", textAlign: "left" }}>
                        Category insights appear here once complaints are analyzed.
                      </p>
                    )}
                  </article>

                  <article className="workspace-panel">
                    <div className="panel-head">
                      <h2>Quick workflow</h2>
                      <span>3 steps</span>
                    </div>
                    <ol className="dash-checklist">
                      <li>
                        <strong>Capture issues</strong>
                        <span>Record complaints manually or share a public form link with customers.</span>
                      </li>
                      <li>
                        <strong>Review AI triage</strong>
                        <span>Check priority scores, sentiment, and severity to spot urgent cases first.</span>
                      </li>
                      <li>
                        <strong>Reply &amp; resolve</strong>
                        <span>Customize the suggested reply draft and update the complaint status.</span>
                      </li>
                    </ol>
                    <Link className="workspace-arrow" href="/docs" style={{ display: "inline-block", marginTop: "10px" }}>
                      Read the User Guide ↗
                    </Link>
                  </article>
                </div>
              </section>
            </>
          )}

          <div className="workspace-grid" style={{ marginTop: "24px" }}>
            <section className="workspace-panel">
              <div className="panel-head">
                <h2>Your workspaces</h2>
                <span>{workspaces.length.toString().padStart(2, "0")}</span>
              </div>
              {workspaces.length ? (
                <ul className="workspace-list">
                  {workspaces.map((workspace) => (
                    <li key={workspace.id}>
                      <span className="workspace-icon">{workspace.name.slice(0, 1).toUpperCase()}</span>
                      <span className="workspace-copy">
                        <strong>{workspace.name}</strong>
                        <small>{workspace.role}</small>
                      </span>
                      <div className="dash-ws-links">
                        <Link className="workspace-arrow" href={`/complaints?workspace=${workspace.id}`}>
                          Complaints ↗
                        </Link>
                        <Link className="workspace-arrow" href={`/analytics?workspaceId=${workspace.id}`}>
                          Analytics ↗
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-state">No workspaces yet. Create one to get started.</p>
              )}
            </section>

            <section className="workspace-panel create-panel">
              <p className="eyebrow">ADD A TEAM SPACE</p>
              <h2>Create a workspace</h2>
              <p>Each workspace keeps its own complaints, forms, and analytics separate.</p>
              <form onSubmit={createWorkspace}>
                <label htmlFor="workspace-name">Workspace name</label>
                <input
                  id="workspace-name"
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  required
                  maxLength={120}
                  placeholder="e.g. Acme Customer Support"
                />
                <button className="primary-link form-submit">
                  Create workspace <span>↗</span>
                </button>
              </form>
            </section>
          </div>
        </section>
      )}
    </main>
  );
}
