"use client";

import { useEffect } from "react";

// Last-resort boundary: this renders when the root layout itself fails,
// so it must carry its own <html>/<body> and cannot rely on globals.css
// having loaded — all styling here is inline and self-contained. Like
// error.tsx, it never renders the raw error or its stack.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: "2rem auto",
          maxWidth: 720,
          padding: "0 1rem",
          color: "#111827",
          background: "#ffffff",
        }}
      >
        <h1>LedgerPilot failed to load</h1>
        <p>
          The application shell itself hit an unexpected error. Try loading it again; if
          the problem persists, restart the instance — in mock mode no state is lost that
          cannot be re-seeded from Judge Mode.
        </p>
        {error.digest ? (
          <p style={{ color: "#6b7280", fontSize: 13 }}>
            Support reference: <code>{error.digest}</code>
          </p>
        ) : null}
        <p>
          <button type="button" onClick={() => reset()}>
            Try again
          </button>
        </p>
      </body>
    </html>
  );
}
