"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";

type User = { id: string; name: string; email: string };
type Workspace = { id: string; name: string; role: string; created_at?: string };

export function WorkspaceDashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    const me = await apiRequest<{ user: User }>("/auth/me");
    if (me.response.status === 401) {
      router.replace("/login");
      return;
    }
    if (!me.response.ok) throw new Error("Could not load your account.");
    const list = await apiRequest<{ workspaces: Workspace[] }>("/workspaces");
    if (!list.response.ok) throw new Error(apiErrorMessage(list.data, "Could not load workspaces."));
    setUser(me.data.user);
    setWorkspaces(list.data.workspaces);
  }

  useEffect(() => {
    load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load your account."))
      .finally(() => setBusy(false));
  }, []);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const { data, response } = await apiRequest<{ workspace?: Workspace; error?: string }>("/workspaces", {
      method: "POST", body: JSON.stringify({ name: workspaceName })
    });
    if (!response.ok || !data.workspace) {
      setError(apiErrorMessage(data, "Could not create workspace."));
      return;
    }
    setWorkspaces((current) => [...current, data.workspace!]);
    setWorkspaceName("");
  }

  async function logout() {
    await apiRequest("/auth/logout", { method: "POST", body: JSON.stringify({}) });
    router.replace("/login");
  }

  return <main className="dashboard-shell">
    <nav className="topbar"><Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link><div className="complaint-nav"><Link className="text-button" href="/complaints">Complaints</Link><Link className="text-button" href="/analytics">Analytics</Link><Link className="text-button" href="/integrations">Integrations</Link><button className="text-button" onClick={logout}>Log out</button></div></nav>
    {busy ? <p className="loading-state">Loading your workspace…</p> : <section className="dashboard-content">
      <p className="eyebrow">YOUR PRIVATE SPACE</p>
      <h1>Welcome, {user?.name ?? "there"}.</h1>
      <p className="dashboard-intro">Your NomaanOS account and team workspaces.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="workspace-grid">
        <section className="workspace-panel"><div className="panel-head"><h2>Your workspaces</h2><span>{workspaces.length.toString().padStart(2, "0")}</span></div>
          {workspaces.length ? <ul className="workspace-list">{workspaces.map((workspace) => <li key={workspace.id}><span className="workspace-icon">{workspace.name.slice(0, 1).toUpperCase()}</span><span className="workspace-copy"><strong>{workspace.name}</strong><small>{workspace.role}</small></span><Link className="workspace-arrow" href={`/analytics?workspaceId=${workspace.id}`}>Analytics ↗</Link></li>)}</ul> : <p className="empty-state">No workspaces yet. Create one to get started.</p>}
        </section>
        <section className="workspace-panel create-panel"><p className="eyebrow">ADD A TEAM SPACE</p><h2>Create a workspace</h2><p>Each workspace has its own membership and access boundaries.</p><form onSubmit={createWorkspace}><label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} required maxLength={120} /><button className="primary-link form-submit">Create workspace <span>↗</span></button></form></section>
      </div>
    </section>}
  </main>;
}