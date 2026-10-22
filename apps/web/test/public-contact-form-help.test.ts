import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, test } from "node:test";
import { PublicContactFormHelp, PublicContactFormHelpDialog } from "../components/public-contact-form-help.js";
import { copyWebsiteButtonCode, helpModalReducer, websiteButtonHtml } from "../lib/public-contact-form-help.js";

describe("public contact form help", () => {
  test("the accessible help trigger starts closed and modal state opens and closes, including Escape", () => {
    const trigger = renderToStaticMarkup(createElement(PublicContactFormHelp, {}));
    assert.match(trigger, /aria-label="Integration help"/);
    assert.match(trigger, /title="How to use the public contact form"/);
    assert.doesNotMatch(trigger, /role="dialog"/);
    assert.equal(helpModalReducer(false, "open"), true);
    assert.equal(helpModalReducer(true, "close"), false);
    assert.equal(helpModalReducer(true, "escape"), false);
  });

  test("the dialog explains the working hosted form flow and displays the actual URL when available", () => {
    const formUrl = 'https://nomaan.example/contact/a&b"c';
    const markup = renderToStaticMarkup(createElement(PublicContactFormHelpDialog, {
      formUrl,
      copyNotice: "",
      closeButton: createRef<HTMLButtonElement>(),
      dialog: createRef<HTMLDivElement>(),
      onClose: () => {},
      onCopy: () => {}
    }));
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-modal="true"/);
    assert.match(markup, /How to Add NomaanOS Complaint Form to Your Website/);
    assert.match(markup, /Step 1: Create your public contact form/);
    assert.match(markup, /Step 2: Add the link to your website/);
    assert.match(markup, /Step 3: Customer submits a complaint/);
    assert.match(markup, /https:\/\/nomaan\.example\/contact\/a&amp;amp;b&amp;quot;c/);
    assert.match(markup, /Copy Website Button Code/);
    assert.match(markup, /workspace mapped to that form/);
    assert.match(markup, /Never place a workspace API credential/);
  });

  test("placeholder instructions and copy code action work without inventing a token", async () => {
    const markup = renderToStaticMarkup(createElement(PublicContactFormHelpDialog, {
      copyNotice: "",
      closeButton: createRef<HTMLButtonElement>(),
      dialog: createRef<HTMLDivElement>(),
      onClose: () => {},
      onCopy: () => {}
    }));
    assert.match(markup, /YOUR-PUBLIC-NOMAANOS-DOMAIN\/contact\/YOUR-FORM-TOKEN/);
    assert.match(markup, /EXAMPLE-FORM-TOKEN/);
    assert.match(markup, /Copy HTML Code/);
    assert.match(markup, /Only your own computer can access that local address/);

    let copied = "";
    await copyWebsiteButtonCode(undefined, { writeText: async (value) => { copied = value; } });
    assert.equal(copied, websiteButtonHtml());
    assert.match(copied, /https:\/\/YOUR-PUBLIC-NOMAANOS-DOMAIN\/contact\/YOUR-FORM-TOKEN/);
  });

  test("website button HTML escapes the generated URL and copies exactly the displayed code", async () => {
    const url = 'https://example.test/contact/token?a=1&b="<script>';
    const expected = websiteButtonHtml(url);
    assert.match(expected, /a=1&amp;b=&quot;&lt;script&gt;/);
    let copied = "";
    await copyWebsiteButtonCode(url, { writeText: async (value) => { copied = value; } });
    assert.equal(copied, expected);
  });
});
