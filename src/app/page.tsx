import ConsoleClient from "./console-client";

export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <h1>LedgerPilot — Operations Console</h1>
      <p>
        An AI money operator for solo sellers and freelancers. Tell it what happened in plain
        English — it drafts, sends, tracks, and reconciles the money through PayPal, and nothing
        executes without your approval. Every agent action and verified webhook lands in the
        audit grid below.
      </p>
      <ConsoleClient />
      <p style={{ color: "#6b7280", fontSize: 13 }}>
        New here? <a href="/judge">Judge Mode</a> seeds the full demo scenario in one click —
        no PayPal account or API key needed. Sandbox / mock mode only — no real money moves.
        Agent pipeline: briefs via{" "}
        <code>POST /api/agent/plan</code>, approval via <code>/api/agent/approve</code>, execution
        via <code>/api/agent/execute</code>; webhooks via <code>POST /api/paypal/webhooks</code>{" "}
        with a polling reconciler at <code>GET /api/paypal/sync</code>.
      </p>
    </main>
  );
}
