"use client";

import { useEffect, useState } from "react";

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
  const aiUrl = process.env.NEXT_PUBLIC_AI_URL ?? "http://localhost:8000";

  return <main className="shell">
    <nav className="topbar"><a className="brand" href="#home"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></a><span className="foundation-tag"><i /> DAY 1 FOUNDATION</span></nav>
    <section className="hero" id="home">
      <div className="hero-copy"><p className="eyebrow">CUSTOMER SUPPORT, WITH CLARITY</p><h1>Every complaint<br />deserves a <em>clear next step.</em></h1><p className="intro">NomaanOS gives support teams a calmer way to understand customer issues, spot what needs attention, and respond with care.</p><a className="primary-link" href="#foundation">Explore the foundation <span>↘</span></a></div>
      <div className="visual-card"><div className="visual-top"><span>THE SUPPORT LOOP</span><span className="live-mark"><i /> READY TO BUILD</span></div><div className="loop"><div className="loop-node"><span className="node-icon">↗</span><span className="node-label">LISTEN</span><small>Customer voice</small></div><div className="loop-line"><span /></div><div className="loop-node active-node"><span className="node-icon">✳</span><span className="node-label">UNDERSTAND</span><small>Clear context</small></div><div className="loop-line"><span /></div><div className="loop-node"><span className="node-icon">↗</span><span className="node-label">RESOLVE</span><small>Thoughtful action</small></div></div><div className="visual-foot"><span>ONE CONVERSATION AT A TIME</span><span>01 / 03</span></div></div>
    </section>
    <section className="foundation" id="foundation"><div className="section-heading"><div><p className="eyebrow">A SOLID START</p><h2>Built in layers.<br /><em>Ready for what’s next.</em></h2></div><p className="section-note">The first milestone sets up the core services that future features will build on. No customer data or accounts yet—just a healthy, connected foundation.</p></div><div className="service-card"><div className="service-header"><span>LOCAL ENVIRONMENT</span><span>DAY 01</span></div><ServiceStatus label="Web application" url="/api/health" /><ServiceStatus label="Application API" url={`${apiUrl}/health`} /><ServiceStatus label="AI service" url={`${aiUrl}/health`} /><div className="service-note"><span className="note-icon">i</span><span>Start the stack with <code>docker compose up --build</code> to bring every service online.</span></div></div></section>
    <footer><a className="brand footer-brand" href="#home"><span className="brand-mark">N</span><span>nomaan<span className="brand-light">OS</span></span></a><span>Thoughtful support starts with a better foundation.</span><span>FOUNDATION / 2026</span></footer>
  </main>;
}
