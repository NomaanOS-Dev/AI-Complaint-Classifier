"use client";

import { useState } from "react";

type ShowcaseScenario = {
  id: string;
  label: string;
  complaintTitle: string;
  complaintSnippet: string;
  category: string;
  sentiment: string;
  severity: "Critical" | "High" | "Medium";
  priorityScore: number;
  replyDraft: string;
};

const SCENARIOS: ShowcaseScenario[] = [
  {
    id: "payment",
    label: "Payment Charged Twice",
    complaintTitle: "Double debit on UPI checkout (#ORD-8821)",
    complaintSnippet: "My account was debited ₹2,499 twice during checkout and order confirmation still says pending.",
    category: "Payment",
    sentiment: "Negative",
    severity: "Critical",
    priorityScore: 92,
    replyDraft: "We apologize for the duplicate debit on #ORD-8821. Our billing team has flagged the extra charge for immediate reversal within 24–48 hours."
  },
  {
    id: "delivery",
    label: "Delayed Shipment",
    complaintTitle: "Parcel stuck in transit for 6 days",
    complaintSnippet: "Tracking hasn't updated since Monday and this was ordered for an upcoming event.",
    category: "Delivery",
    sentiment: "Negative",
    severity: "High",
    priorityScore: 76,
    replyDraft: "Thank you for flagging this delay. We have escalated your shipment with our courier partner and will share an updated ETA today."
  },
  {
    id: "account",
    label: "2FA Login Lockout",
    complaintTitle: "Unable to sign in after password reset",
    complaintSnippet: "Verification link opened properly, but my team workspace still shows access denied.",
    category: "Account",
    sentiment: "Neutral",
    severity: "Medium",
    priorityScore: 54,
    replyDraft: "We have refreshed your session permissions. Please sign out once and log back in with your updated password."
  }
];

export function InteractiveShowcase() {
  const [selectedId, setSelectedId] = useState<string>(SCENARIOS[0].id);
  const current = SCENARIOS.find((s) => s.id === selectedId) ?? SCENARIOS[0];

  return (
    <div className="visual-card showcase-card">
      <div className="visual-top">
        <span>LIVE AI TRIAGE PREVIEW</span>
        <span className="live-mark">
          <i /> ENGINE READY
        </span>
      </div>

      <div className="showcase-tabs" role="tablist" aria-label="Sample complaint scenarios">
        {SCENARIOS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === current.id}
            className={`showcase-tab ${item.id === current.id ? "active" : ""}`}
            onClick={() => setSelectedId(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div key={current.id} className="showcase-body">
        <div className="showcase-input-box">
          <span className="showcase-label">Incoming complaint</span>
          <strong>{current.complaintTitle}</strong>
          <p>{current.complaintSnippet}</p>
        </div>

        <div className="showcase-metrics">
          <div className="showcase-pill">
            <span>Category</span>
            <strong>{current.category}</strong>
          </div>
          <div className="showcase-pill">
            <span>Sentiment</span>
            <strong>{current.sentiment}</strong>
          </div>
          <div className="showcase-pill">
            <span>Severity</span>
            <strong className={`sev-${current.severity.toLowerCase()}`}>{current.severity}</strong>
          </div>
        </div>

        <div className="showcase-score-row">
          <div className="showcase-score-head">
            <span>Priority score</span>
            <strong>{current.priorityScore} / 100</strong>
          </div>
          <div className="usage-bar-track">
            <div
              className={`usage-bar-fill ${current.priorityScore >= 85 ? "danger" : current.priorityScore >= 70 ? "warning" : ""}`}
              style={{ width: `${current.priorityScore}%` }}
            />
          </div>
        </div>

        <div className="showcase-reply-box">
          <span className="showcase-label">AI suggested reply draft</span>
          <p>{current.replyDraft}</p>
        </div>
      </div>

      <div className="visual-foot">
        <span>AUTOMATIC CLASSIFICATION</span>
        <span>01 / 03</span>
      </div>
    </div>
  );
}
