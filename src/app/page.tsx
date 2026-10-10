export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "3rem auto", maxWidth: 720, padding: "0 1rem" }}>
      <h1>LedgerPilot</h1>
      <p>
        An AI money operator for solo sellers and freelancers. Tell it what happened in plain
        English — it drafts, sends, tracks, and reconciles the money through PayPal, and nothing
        executes without your approval.
      </p>
      <p>
        <strong>Status:</strong> foundations milestone — PayPal adapter layer (mock-first) is in
        place. The operations console and agent plan/execute pipeline land in the core-loop
        milestone.
      </p>
    </main>
  );
}
