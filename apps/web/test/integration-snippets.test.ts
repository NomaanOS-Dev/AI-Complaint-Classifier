import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { embedSnippetFor, sourceFor, type Technology } from "../lib/integration-snippets.js";

describe("Embed & Integrate Form code examples", () => {
  test("embed snippets contain the generated URL for HTML, React, and Next.js", () => {
    const url = "https://forms.example.test/contact/public-token";
    for (const technology of ["HTML + JavaScript", "React", "Next.js"] as Technology[]) {
      const snippet = embedSnippetFor(url, technology);
      assert.ok(snippet.includes(url));
      assert.match(snippet, /iframe/);
      assert.match(snippet, /title="Submit a complaint"/);
    }
    assert.match(embedSnippetFor(url, "HTML + JavaScript"), /width="100%"/);
  });

  test("HTML and React browser examples call the business backend and forward idempotency", () => {
    for (const technology of ["HTML + JavaScript", "React"] as Technology[]) {
      const snippet = sourceFor(technology);
      assert.match(snippet, /\/api\/submit-complaint/);
      assert.match(snippet, /idempotency-key/);
      assert.match(snippet, /customer_email.*trim|customer_email\.trim/);
      assert.doesNotMatch(snippet, /\/api\/v1\/integrations\/complaints/);
      assert.doesNotMatch(snippet, /authorization:\s*['"]Bearer/);
    }
  });

  test("Next.js and generic backend snippets use the existing server-only ingestion contract", () => {
    const next = sourceFor("Next.js");
    assert.match(next, /\/api\/v1\/integrations\/complaints/);
    assert.match(next, /NOMAANOS_API_CREDENTIAL/);
    assert.match(next, /NOMAANOS_API_URL/);
    assert.match(next, /idempotency-key/);
    assert.match(next, /AbortSignal\.timeout\(8000\)/);
    assert.match(next, /emailValue \|\| undefined/);
    assert.doesNotMatch(next, /NEXT_PUBLIC_NOMAANOS_API_CREDENTIAL/);
    const generic = sourceFor("Generic backend");
    assert.match(generic, /\/api\/v1\/integrations\/complaints/);
    assert.match(generic, /NOMAANOS_API_CREDENTIAL/);
    assert.match(generic, /idempotency-key/);
  });
});
