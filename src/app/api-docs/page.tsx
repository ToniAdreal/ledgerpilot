import type { Metadata } from "next";
import { buildApiDocsSections } from "@/lib/api";

// Page-specific metadata for the API documentation page (the
// human-readable rendering of the OpenAPI registry in src/lib/api/).
// No URL is declared: no public host exists before the hosted
// deployment, and none is invented here (same rule as the root
// layout's metadata).
export const metadata: Metadata = {
  title: "LedgerPilot — API Documentation",
  description:
    "The LedgerPilot HTTP API, operation by operation: the agent, console, PayPal, Judge Mode, and health surfaces, rendered from the same registry as the OpenAPI document. Sandbox / mock only — no real money moves.",
};

export default function ApiDocsPage() {
  const sections = buildApiDocsSections();
  const operationCount = sections.reduce((sum, s) => sum + s.operations.length, 0);
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <p>
        <a href="/">← Operations Console</a>
      </p>
      <h1>API documentation</h1>
      <p>
        Every HTTP operation LedgerPilot serves — {operationCount} operations, grouped by
        surface. This page is rendered from the same registry that builds the
        machine-readable OpenAPI 3.1 document at{" "}
        <a href="/api/openapi">
          <code>GET /api/openapi</code>
        </a>
        , so the two can never drift apart: a route added without a registry entry fails
        the test suite, and this page lists exactly what the document describes.
      </p>
      <p>
        Two honesty notes, stated here as plainly as in the document itself. This API has{" "}
        <strong>no authentication layer</strong>: every operation declares{" "}
        <code>security: []</code>, the approval gate is an application invariant (no plan
        executes without an approval decision) rather than authentication, and a publicly
        exposed instance needs the deployer&apos;s own access controls. And every draft
        surface below only ever drafts a <code>pending_approval</code> plan — no API call
        on this page moves money by itself. The demo scenario starts in{" "}
        <a href="/judge">Judge Mode</a>. Sandbox / mock mode only — no real money moves.
      </p>
      {sections.map((section) => (
        <section key={section.tag}>
          <h2>{section.tag}</h2>
          <p style={{ color: "#4b5563" }}>{section.description}</p>
          {section.operations.map((op) => (
            <article key={op.operationId} style={{ borderTop: "1px solid #e5e7eb", padding: "0.75rem 0" }}>
              <h3 style={{ margin: "0.25rem 0" }}>
                <code>
                  {op.method.toUpperCase()} {op.path}
                </code>{" "}
                — {op.summary}
              </h3>
              <p style={{ margin: "0.25rem 0" }}>{op.description}</p>
              {op.requestBody ? (
                <p style={{ margin: "0.25rem 0" }}>
                  <em>
                    {op.webhookEventBody
                      ? "Request body: a JSON webhook event carrying id and event_type."
                      : "Request body: JSON."}
                  </em>
                </p>
              ) : null}
              <ul style={{ margin: "0.25rem 0" }}>
                {Object.entries(op.responses).map(([code, description]) => (
                  <li key={code}>
                    <code>{code}</code> — {description}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      ))}
    </main>
  );
}
