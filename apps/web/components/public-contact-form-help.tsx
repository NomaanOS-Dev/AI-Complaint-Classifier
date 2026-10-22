"use client";

import { useEffect, useRef, useReducer, useState, type RefObject } from "react";
import { copyWebsiteButtonCode, helpModalReducer, websiteButtonHtml } from "../lib/public-contact-form-help";

type Props = { formUrl?: string };

export function PublicContactFormHelp({ formUrl }: Props) {
  const [isOpen, dispatch] = useReducer(helpModalReducer, false);
  const [copyNotice, setCopyNotice] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dispatch("escape");
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus.current?.focus();
    };
  }, [isOpen]);

  async function copyCode() {
    try {
      await copyWebsiteButtonCode(formUrl, navigator.clipboard);
      setCopyNotice("Website button code copied.");
    } catch {
      setCopyNotice("Could not copy the code. Select and copy it manually.");
    }
  }

  return <>
    <button
      type="button"
      className="contact-form-help-trigger"
      aria-label="Integration help"
      aria-describedby="public-contact-form-help-tooltip"
      data-tooltip="How to use the public contact form"
      title="How to use the public contact form"
      onClick={() => { setCopyNotice(""); dispatch("open"); }}
    >i</button><span id="public-contact-form-help-tooltip" className="visually-hidden">How to use the public contact form</span>
    {isOpen && <PublicContactFormHelpDialog
      formUrl={formUrl}
      copyNotice={copyNotice}
      closeButton={closeButton}
      dialog={dialog}
      onClose={() => dispatch("close")}
      onCopy={() => void copyCode()}
    />}
  </>;
}

type DialogProps = Props & {
  copyNotice: string;
  closeButton: RefObject<HTMLButtonElement | null>;
  dialog: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onCopy: () => void;
};

export function PublicContactFormHelpDialog({ formUrl, copyNotice, closeButton, dialog, onClose, onCopy }: DialogProps) {
  return <div className="contact-form-help-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div
      className="contact-form-help-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="contact-form-help-title"
      ref={dialog}
    >
      <div className="contact-form-help-heading">
        <h2 id="contact-form-help-title">How to Add NomaanOS Complaint Form to Your Website</h2>
        <button
          type="button"
          className="contact-form-help-close"
          aria-label="Close public contact form help"
          ref={closeButton}
          onClick={onClose}
        >×</button>
      </div>
      <div className="contact-form-help-content">
        <section>
          <h3>Step 1: Create your public contact form</h3>
          <ol>
            <li>Open the NomaanOS dashboard.</li>
            <li>Navigate to <strong>Integrations → Public contact form</strong>.</li>
            <li>Click <strong>Create contact form link</strong>.</li>
            <li>NomaanOS generates a unique URL mapped to the selected workspace. For example: <code>http://localhost:3000/contact/EXAMPLE-FORM-TOKEN</code></li>
          </ol>
          <p className="contact-form-help-note">This is an example URL only. Use the actual link generated for the current workspace. A form token is stored as a hash and cannot be recovered later; create or rotate the link to reveal a new URL.</p>
        </section>
        <section>
          <h3>Step 2: Add the link to your website</h3>
          <p>Add the generated URL to your website’s existing <strong>Submit a Complaint</strong> button. When a customer clicks it, the NomaanOS-hosted complaint form opens.</p>
          <h4>HTML Website</h4>
          <pre className="contact-form-help-code"><code>{websiteButtonHtml(formUrl)}</code></pre>
          <button type="button" className="filter-button" onClick={onCopy}>
            {formUrl ? "Copy Website Button Code" : "Copy HTML Code"}
          </button>
          <p className="contact-form-help-note" role="status" aria-live="polite">{copyNotice}</p>
          {!formUrl && <p className="contact-form-help-note">No generated URL is available in this session. Create or rotate the public form link first; the example above uses a placeholder URL.</p>}
          <ul className="contact-form-help-list">
            <li>Replace the placeholder URL with the actual public contact form URL generated by NomaanOS. The URL shown in the example is not a real link.</li>
            <li>During local development, the generated URL may start with <code>http://localhost:3000</code>. Only your own computer can access that local address.</li>
            <li>For real customers, deploy NomaanOS to a publicly accessible HTTPS domain and use the URL generated for that deployment.</li>
            <li>You can customize the button text, colors, and styling.</li>
            <li>This button redirects customers to the NomaanOS-hosted form; it does not embed the form inside your website.</li>
          </ul>
        </section>
        <section>
          <h3>Step 3: Customer submits a complaint</h3>
          <ol>
            <li>A customer visits the business website.</li>
            <li>The customer clicks <strong>Submit a Complaint</strong>.</li>
            <li>The NomaanOS-hosted form opens.</li>
            <li>The customer fills out and submits the form.</li>
            <li>NomaanOS validates the public token and saves the complaint to the workspace mapped to that form.</li>
            <li>The business can view the complaint in that workspace’s complaint dashboard.</li>
          </ol>
          <p className="contact-form-help-note">The public form uses server-side workspace mapping, validation, idempotency, and rate limits. Never place a workspace API credential in this button or in browser-side code.</p>
        </section>
      </div>
    </div>
  </div>;
}