import JudgeClient from "./judge-client";

export const metadata = {
  title: "LedgerPilot — Judge Mode",
  description: "One-click seeded demo of the LedgerPilot money-operator loop on PayPal (sandbox / mock).",
};

export default function JudgePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 900, padding: "0 1rem" }}>
      <h1>LedgerPilot — Judge Mode</h1>
      <p>
        The fastest way to see LedgerPilot work: one click seeds a fictional seller history and
        the exact demo-spine plan from the video — an invoice to Ana that, once paid, triggers a
        contractor payout to Marco. You approve and execute the plan yourself in the{" "}
        <a href="/">Operations Console</a>, so the approval gate and the audit trail you see are
        the product's real ones. No PayPal account, no API keys, no install.
      </p>
      <JudgeClient />
    </main>
  );
}
