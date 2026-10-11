"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log for the operator's console only. The rendered page never shows
    // the raw error message or stack: either can carry internal detail
    // that does not belong on a shared demo screen.
    console.error(error);
  }, [error]);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        margin: "2rem auto",
        maxWidth: 720,
        padding: "0 1rem",
      }}
    >
      <h1>Something went wrong</h1>
      <p>
        This part of LedgerPilot hit an unexpected error and stopped instead of guessing.
        Nothing is retried automatically: try rendering it again, or go back to the
        Operations Console.
      </p>
      {error.digest ? (
        <p style={{ color: "#6b7280", fontSize: 13 }}>
          Support reference: <code>{error.digest}</code>
        </p>
      ) : null}
      <p style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button type="button" onClick={() => reset()}>
          Try again
        </button>
        <a href="/">Back to the Operations Console</a>
      </p>
    </main>
  );
}
