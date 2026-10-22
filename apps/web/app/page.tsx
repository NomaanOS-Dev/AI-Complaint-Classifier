"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ServiceState = "checking" | "online" | "offline";

function ServiceStatus({ label, url }: { label: string; url: string }) {
  const [state, setState] = useState<ServiceState>("checking");

  useEffect(() => {
    let active = true;
    fetch(url).then((response) => {
      if (active) setState(response.ok ? "online" : "offline");
    }).catch(() => {
      if (active) setState("offline");
    });
    return () => { active = false; };
  }, [url]);

  return <div className="service-row"><span>{label}</span><span className={`status ${state}`}><i />{state === "checking" ? "Checking" : state === "online" ? "Online" : "Offline"}</span></div>;
}

export default function Home() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const aiUrl = process.env.NEXT_PUBLIC_AI_URL ?? "http://localhost:8001";

  return <main className="shell">
    <nav className="topbar">
      <Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link>
      <div className="complaint-nav">
        <Link className="text-button" href="/login">Sign in</Link>
        <Link className="primary-link" style={{ padding: "8px 16px", fontSize: "0.85rem" }} href="/register">Create account</Link>
      </div>
    </nav>
    <section className="hero">
      <div className="hero-copy">
        <p className="eyebrow">CUSTOMER SUPPORT, WITH CLARITY</p>
        <h1>Every complaint<br />deserves a <em>clear next step.</em></h1>
        <p className="intro">NomaanOS gives support teams a calmer way to understand customer issues, spot what needs attention, and respond with care.</p>
        <Link className="primary-link" href="/register">Create your workspace <span>↗</span></Link>
      </div>
      <div className="visual-card">
        <div className="visual-top"><span>THE SUPPORT LOOP</span><span className="live-mark"><i /> READY TO BUILD</span></div>
        <div className="loop">
          <div className="loop-node"><span className="node-icon">↗</span><span className="node-label">LISTEN</span><small>Customer voice</small></div>
          <div className="loop-node active-node"><span className="node-icon">✳</span><span className="node-label">UNDERSTAND</span><small>Clear context</small></div>
          <div className="loop-node"><span className="node-icon">↗</span><span className="node-label">RESOLVE</span><small>Thoughtful action</small></div>
        </div>
        <div className="visual-foot"><span>ONE CONVERSATION AT A TIME</span><span>01 / 03</span></div>
      </div>
    </section>
    <section className="foundation">
      <div className="section-heading">
        <p className="eyebrow">A SOLID START</p>
        <h2>Private workspaces.<br /><em>Access with care.</em></h2>
        <p className="section-note">Create a company workspace, manage your membership, and keep each team’s data behind server-checked access controls.</p>
      </div>
      <div className="service-card">
        <div className="service-header"><span>LOCAL ENVIRONMENT</span><span>DAY 02</span></div>
        <ServiceStatus label="Web application" url="/api/health" />
        <ServiceStatus label="Application API" url={`${apiUrl}/health`} />
        <ServiceStatus label="AI service" url={`${aiUrl}/health`} />
        <div className="service-note"><span className="note-icon">i</span><span>Sign up to create your account and first owner workspace.</span></div>
      </div>
    </section>
    <footer>
      <Link className="brand" href="/"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></Link>
      <span>Thoughtful support starts with a better foundation.</span>
      <span>FOUNDATION / 2026</span>
    </footer>
  </main>;
}