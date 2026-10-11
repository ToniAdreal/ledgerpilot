export const metadata = {
  title: "LedgerPilot — Page not found",
  description: "That LedgerPilot page does not exist.",
};

export default function NotFound() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        fontFamily: "system-ui, sans-serif",
        margin: "2rem auto",
        maxWidth: 720,
        padding: "0 1rem",
      }}
    >
      <h1>404 — Page not found</h1>
      <p>
        That page does not exist in LedgerPilot. The link may be mistyped, or the page may
        have moved — no money, plan, or record was affected by following it.
      </p>
      <p>
        <a href="/">Open the Operations Console</a> or{" "}
        <a href="/judge">start from Judge Mode</a>, which seeds the full demo scenario in
        one click.
      </p>
    </main>
  );
}
