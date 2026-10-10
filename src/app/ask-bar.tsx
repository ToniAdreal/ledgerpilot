"use client";

/**
 * Ask-the-grid bar — plain-language queries compiled by the
 * deterministic parser in src/lib/ask into validated AG Grid filter
 * models. The parser runs client-side (pure, no network); the parent
 * console applies the returned models via `api.setFilterModel(...)`
 * and clears grids the query did not target, so the visible effect
 * of a question is always exactly what the readout below says.
 *
 * An unparseable query changes nothing: the error is shown verbatim
 * and the grids keep their current filters.
 */

import { useCallback, useState } from "react";
import { EXAMPLE_ASKS, parseAskQuery, type AskResult } from "../lib/ask";

export default function AskBar({
  onApply,
  onClear,
}: {
  onApply: (result: AskResult) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(
    (raw: string) => {
      try {
        const parsed = parseAskQuery(raw);
        setResult(parsed);
        setError(null);
        onApply(parsed);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not parse that query");
      }
    },
    [onApply],
  );

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
    onClear();
  }, [onClear]);

  return (
    <section className="ask-bar" aria-label="Ask the grid">
      <h2>Ask the grid</h2>
      <p className="command-hint">
        Ask in plain English — the deterministic parser compiles your question into validated grid
        filters. Nothing is sent anywhere; try a status, an amount, a person, or a date.
      </p>
      <div className="command-input-row">
        <input
          className="command-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") ask(query);
          }}
          placeholder="Show unpaid invoices over $200 from this month"
          aria-label="Ask the grid query"
        />
        <button type="button" className="command-btn command-btn-primary" onClick={() => ask(query)}>
          Ask
        </button>
        <button type="button" className="command-btn" onClick={clear}>
          Clear filters
        </button>
      </div>
      <div className="example-chips">
        {EXAMPLE_ASKS.map((ex) => (
          <button
            key={ex.label}
            type="button"
            className="example-chip"
            onClick={() => {
              setQuery(ex.query);
              ask(ex.query);
            }}
          >
            {ex.label}
          </button>
        ))}
      </div>

      {error && <p className="console-error">Ask failed: {error}</p>}

      {result && (
        <div className="ask-result" role="status">
          <p className="ask-summary">{result.summary}</p>
          {result.notes.map((note) => (
            <p key={note} className="ask-note">
              {note}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
