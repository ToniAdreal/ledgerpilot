"use client";

/**
 * Judge Mode client — loads the scenario state from GET /api/judge,
 * seeds via POST /api/judge/seed, closes the payment leg via
 * POST /api/judge/pay, and resets the demo instance via
 * POST /api/judge/reset (mock mode only). Approving/executing the
 * spine plan deliberately happens in the Operations Console's Agent
 * Command bar — the judge experiences the real approval gate, not a
 * Judge-Mode shortcut.
 */

import { useCallback, useEffect, useState } from "react";
import type { JudgeScenario, JudgeState } from "../../lib/judge";

interface JudgePayload {
  scenario: JudgeScenario;
  state: JudgeState;
}

export default function JudgeClient() {
  const [payload, setPayload] = useState<JudgePayload | null>(null);
  const [busy, setBusy] = useState<"seed" | "pay" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/judge");
      setPayload((await res.json()) as JudgePayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Judge Mode state");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const seed = useCallback(async () => {
    setBusy("seed");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/judge/seed", { method: "POST" });
      const json = (await res.json()) as { alreadySeeded?: boolean; error?: string };
      if (!res.ok) {
        setError(json.error ?? `Seeding failed (HTTP ${res.status})`);
        return;
      }
      setNotice(
        json.alreadySeeded
          ? "The scenario was already loaded — nothing was duplicated."
          : "Scenario loaded. Head to the Operations Console: the spine plan is waiting in the Agent Command bar's pending queue.",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to seed Judge Mode");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const pay = useCallback(async () => {
    setBusy("pay");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/judge/pay", { method: "POST" });
      const json = (await res.json()) as {
        alreadyPaid?: boolean;
        spinePlanStatus?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? `Payment simulation failed (HTTP ${res.status})`);
        return;
      }
      setNotice(
        json.alreadyPaid
          ? "The spine invoice is already PAID — no second payment was recorded."
          : `Payment recorded and reconciled. Spine plan status: ${json.spinePlanStatus ?? "unknown"}. Open the console to see the payout and the full audit trace.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to simulate payment");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const reset = useCallback(async () => {
    if (
      !window.confirm(
        "Reset the demo? This clears every plan, audit record, and mock PayPal resource in this instance, so the scenario can be loaded and run again from a clean slate.",
      )
    ) {
      return;
    }
    setBusy("reset");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/judge/reset", { method: "POST" });
      const json = (await res.json()) as {
        cleared?: { plans: number; invoices: number; orders: number; payouts: number };
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? `Reset failed (HTTP ${res.status})`);
        return;
      }
      const cleared = json.cleared;
      setNotice(
        cleared && (cleared.plans > 0 || cleared.invoices > 0 || cleared.orders > 0 || cleared.payouts > 0)
          ? `Demo reset — cleared ${cleared.plans} plan(s), ${cleared.invoices} invoice(s), ${cleared.orders} order(s), and ${cleared.payouts} payout batch(es). Load the scenario to run it again.`
          : "Demo reset — the instance was already on a clean slate.",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset the demo");
    } finally {
      setBusy(null);
    }
  }, [load]);

  if (!payload) {
    return <p>{error ? `Judge Mode failed to load: ${error}` : "Loading Judge Mode…"}</p>;
  }

  const { scenario, state } = payload;
  const planStatus = state.spinePlan?.status ?? null;
  const canPay = Boolean(state.spineInvoice) && state.spineInvoice?.status !== "PAID";

  return (
    <section>
      <div className="judge-card">
        <h2>{state.seeded ? "Scenario loaded" : "Scenario not loaded yet"}</h2>
        <p>
          Reference date: <strong>{scenario.referenceDate}</strong> · Console contents:{" "}
          {state.counts.invoices} invoices · {state.counts.orders} orders · {state.counts.payouts}{" "}
          payout batches · {state.counts.plans} plans
        </p>
        {state.spinePlan && (
          <p>
            Spine plan <strong>{state.spinePlan.id}</strong>:{" "}
            <span className={`pill pill-${planStatus?.replace(/[^a-z]+/g, "-")}`}>{planStatus}</span>
            {state.spineInvoice && (
              <>
                {" "}
                · Spine invoice <strong>{state.spineInvoice.id}</strong>:{" "}
                {state.spineInvoice.currency_code} {state.spineInvoice.amount} —{" "}
                {state.spineInvoice.status}
              </>
            )}
          </p>
        )}
        <div className="plan-actions">
          <button
            type="button"
            className="command-btn command-btn-primary"
            disabled={busy !== null}
            onClick={() => void seed()}
          >
            {busy === "seed" ? "Loading…" : state.seeded ? "Scenario already loaded" : "Load Judge Mode scenario"}
          </button>
          <a className="command-btn judge-link-btn" href="/">
            Open the Operations Console
          </a>
          <button
            type="button"
            className="command-btn"
            disabled={busy !== null || !canPay}
            onClick={() => void pay()}
            title={canPay ? "Record-payment for the spine invoice, then sync" : "Available once the spine plan has been executed and its invoice is still unpaid"}
          >
            {busy === "pay" ? "Recording payment…" : "Simulate invoice payment"}
          </button>
          <button
            type="button"
            className="command-btn"
            disabled={busy !== null}
            onClick={() => void reset()}
            title="Mock mode only: clear every plan, audit record, and mock PayPal resource so the scenario can be loaded and run again"
          >
            {busy === "reset" ? "Resetting…" : "Reset demo"}
          </button>
        </div>
        {notice && <p className="plan-outcome">{notice}</p>}
        {error && <p className="console-error">Judge Mode: {error}</p>}
      </div>

      <h2>Seeded history — what the one click puts in place</h2>
      <ul className="judge-list">
        {scenario.seededHistory.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h2>The script — exactly what will happen</h2>
      <ol className="judge-steps">
        {scenario.steps.map((step) => (
          <li key={step.title} className="judge-step">
            <strong>{step.title}</strong>
            <span className="plan-step-trigger">{step.actor}</span>
            <p>{step.description}</p>
          </li>
        ))}
      </ol>

      <h2>What success looks like</h2>
      <ul className="judge-list">
        {scenario.expectedOutcome.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <p className="command-hint">
        The spine brief, verbatim: “{scenario.brief}” Sandbox / mock mode only — no real money
        moves, no PayPal account or API key is needed, and the deterministic agent (no LLM) is the
        default brain.
      </p>
    </section>
  );
}
