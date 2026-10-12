import type { Metadata } from "next";
import CommandClient from "./command-client";

// Page-specific metadata for the standalone command page
// (CONCEPT.md §3.1 lists /command — "or console drawer" — as the
// Agent plan review surface). No URL is declared: no public host
// exists before the hosted deployment, and none is invented
// here (same rule as the root layout's metadata).
export const metadata: Metadata = {
  title: "LedgerPilot — Agent Command",
  description:
    "Draft a typed LedgerPilot action plan from a plain-English brief and review it step by step — the exact PayPal calls, any trigger-gated steps — then approve, reject, or execute it through the approval gate. Sandbox / mock only — no real money moves.",
};

export default function CommandPage() {
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <p>
        <a href="/">← Operations Console</a>
      </p>
      <h1>Agent Command</h1>
      <p>
        The agent plan review gets its own page: the same Agent Command bar the console
        hosts, at an addressable route — write a plain-English brief, review the typed
        action plan as a checklist with the exact PayPal calls listed and any
        trigger-gated steps marked, then Approve, Reject, or Execute it. Nothing
        executes without approval: drafting a plan moves no money, an unapproved or
        rejected plan executes nothing, and a trigger-gated step runs only when its
        event arrives — the server-side approval gate is the enforcement point, here
        exactly as in the <a href="/">Operations Console</a>. Plans drafted here are
        the console&apos;s plans (the pending-decision queue is shared), and the demo
        scenario starts in <a href="/judge">Judge Mode</a>.
      </p>
      <CommandClient />
    </main>
  );
}
