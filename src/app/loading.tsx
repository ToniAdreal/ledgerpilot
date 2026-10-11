export default function Loading() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      role="status"
      aria-live="polite"
      style={{
        fontFamily: "system-ui, sans-serif",
        margin: "2rem auto",
        maxWidth: 1180,
        padding: "0 1rem",
      }}
    >
      <h1>LedgerPilot — Operations Console</h1>
      <p>Loading…</p>
      <p style={{ color: "#6b7280", fontSize: 13 }}>
        The console is loading. If this persists, the instance may still be starting —
        check <code>GET /api/health</code> for its readiness state.
      </p>
    </main>
  );
}
