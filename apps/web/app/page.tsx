"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BrandMark, TwoLayerNavbar } from "../components/brand-logo";
import { InteractiveShowcase } from "../components/interactive-showcase";
import { Reveal } from "../components/motion-primitives";

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

const capabilities = [
  {
    eyebrow: "AI CLASSIFICATION",
    title: "Automatic categorization",
    copy: "Every complaint is sorted into Payment, Refund, Delivery, Account, Technical, Product quality, or Other right after arrival."
  },
  {
    eyebrow: "PRIORITY TRIAGE",
    title: "Sentiment, severity & score",
    copy: "Scores urgency from 0 to 100 and surfaces critical issues with clear alert banners so high-impact cases never wait."
  },
  {
    eyebrow: "AGENT ASSIST",
    title: "Editable reply drafts",
    copy: "Generates a polite, context-aware response draft for every complaint that agents can tailor and copy in one click."
  },
  {
    eyebrow: "CUSTOMER INTAKE",
    title: "Hosted & embedded forms",
    copy: "Share a hosted support link or embed a customizable complaint form directly on your website with zero login required for customers."
  },
  {
    eyebrow: "AUDIT TRAIL",
    title: "Status & activity timeline",
    copy: "Move tickets across Open, In progress, Resolved, and Closed while keeping a chronological history of every update."
  },
  {
    eyebrow: "INSIGHTS",
    title: "Date-filtered analytics",
    copy: "Track total volume, unresolved backlog, resolution rate, average resolution hours, and daily trends across custom date ranges."
  }
];

export default function Home() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const aiUrl = process.env.NEXT_PUBLIC_AI_URL ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:8001");

  return <main className="shell">
    <TwoLayerNavbar>
      <Link className="text-button" href="/pricing">Pricing</Link>
      <Link className="text-button" href="/docs">Docs</Link>
      <Link className="text-button" href="/login">Sign in</Link>
      <Link className="primary-link" style={{ padding: "8px 16px", fontSize: "0.85rem" }} href="/register">Create account</Link>
    </TwoLayerNavbar>

    <section className="hero hero-futuristic">
      <div className="hero-ambient" aria-hidden="true">
        <span className="hero-orb orb-a" />
        <span className="hero-orb orb-b" />
      </div>
      <div className="hero-copy hero-stagger">
        <p className="eyebrow">CUSTOMER SUPPORT, WITH CLARITY</p>
        <h1>Every complaint<br />deserves a <em>clear next step.</em></h1>
        <p className="intro">NomaanOS gives support teams a calmer way to capture customer issues, spot what needs urgent attention with AI, and resolve tickets faster.</p>
        <div className="home-hero-actions">
          <Link className="primary-link" href="/register">Create your workspace <span>↗</span></Link>
          <Link className="filter-button" href="/pricing">View pricing</Link>
          <Link className="filter-button" href="/docs">Read User Guide</Link>
        </div>
      </div>
      <Reveal delay={120}>
        <InteractiveShowcase />
      </Reveal>
    </section>

    <section className="home-section">
      <Reveal className="home-section-head">
        <p className="eyebrow">PLATFORM CAPABILITIES</p>
        <h2>Built for modern support teams.</h2>
        <p className="dashboard-intro">Everything you need to move from messy complaint queues to structured, measurable resolution.</p>
      </Reveal>
      <div className="home-feature-grid">
        {capabilities.map((item, idx) => (
          <Reveal key={item.title} delay={idx * 65}>
            <article className="workspace-panel home-feature-card interactive-card">
              <p className="eyebrow">{item.eyebrow}</p>
              <h3>{item.title}</h3>
              <p>{item.copy}</p>
            </article>
          </Reveal>
        ))}
      </div>
    </section>

    <section className="home-section">
      <Reveal className="home-section-head">
        <p className="eyebrow">HOW IT WORKS</p>
        <h2>From customer message to resolution in three steps.</h2>
      </Reveal>
      <div className="home-steps-grid">
        <Reveal delay={0}>
          <article className="workspace-panel home-step-card interactive-card">
            <span className="home-step-num">01</span>
            <h3>Collect complaints</h3>
            <p>Log customer issues manually in your workspace or share a hosted or embedded contact form on your website.</p>
          </article>
        </Reveal>
        <Reveal delay={90}>
          <article className="workspace-panel home-step-card interactive-card">
            <span className="home-step-num">02</span>
            <h3>Automatic AI triage</h3>
            <p>NomaanOS assigns category, sentiment, severity, a 0–100 priority score, a short reasoning summary, and a reply draft.</p>
          </article>
        </Reveal>
        <Reveal delay={180}>
          <article className="workspace-panel home-step-card interactive-card">
            <span className="home-step-num">03</span>
            <h3>Respond &amp; measure</h3>
            <p>Edit and copy the suggested reply, update ticket status, and review resolution performance in Analytics.</p>
          </article>
        </Reveal>
      </div>
    </section>

    <section className="foundation">
      <Reveal className="section-heading">
        <p className="eyebrow">ISOLATED &amp; RELIABLE</p>
        <h2>Private workspaces.<br /><em>Access with care.</em></h2>
        <p className="section-note">Create a company workspace, verify your account email, and keep each team’s complaints, forms, and insights cleanly separated.</p>
      </Reveal>
      <Reveal delay={100}>
        <div className="service-card interactive-card">
          <div className="service-header"><span>SYSTEM HEALTH</span><span>LIVE STATUS</span></div>
          <ServiceStatus label="Web application" url="/api/health" />
          <ServiceStatus label="Application API" url={`${apiUrl}/health`} />
          {aiUrl ? (
            <ServiceStatus label="AI service" url={`${aiUrl}/health`} />
          ) : (
            <div className="service-row"><span>AI service</span><span className="status online"><i />Internal</span></div>
          )}
          <div className="service-note"><span className="note-icon">i</span><span>Sign up to create your account and first owner workspace.</span></div>
        </div>
      </Reveal>
    </section>

    <section className="home-section">
      <Reveal>
        <div className="workspace-panel home-cta-banner interactive-card">
          <div>
            <p className="eyebrow">GET STARTED</p>
            <h2>Bring calm and speed to customer complaints.</h2>
            <p className="dashboard-intro">Create your workspace in under a minute or explore the step-by-step User Guide.</p>
          </div>
          <div className="home-hero-actions">
            <Link className="primary-link" href="/register">Create account <span>↗</span></Link>
            <Link className="filter-button" href="/docs">Open User Guide</Link>
          </div>
        </div>
      </Reveal>
    </section>

    <footer>
      <Link className="brand" href="/"><BrandMark size={28} /><span>nomaan<span className="brand-light">OS</span></span></Link>
      <span>Thoughtful support starts with a better foundation.</span>
      <div className="complaint-nav">
        <Link className="text-button" href="/docs">User Guide</Link>
        <Link className="text-button" href="/login">Sign in</Link>
      </div>
    </footer>
  </main>;
}
