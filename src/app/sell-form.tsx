"use client";

/**
 * Sell form — the console form for CONCEPT.md §3.1's "/checkout —
 * 'Sell something' flow: create an Orders v2 checkout link, show
 * buyer view".
 *
 * The form never calls PayPal and never creates an order: it POSTs
 * the sale to /api/paypal/orders, which validates again server-side
 * and drafts a `pending_approval` plan. The plan review below (exact
 * PayPal call) and the Approve / Execute buttons are the same gate
 * the Agent Command bar and the batch builder use — the order is
 * created only through /api/agent/approve + /api/agent/execute,
 * after which the Orders grid's Buyer view surfaces its checkout
 * link. All form rules live in src/lib/checkout/order-form.ts so
 * they are unit-tested; this component is a thin shell over them.
 */

import { useCallback, useState } from "react";
import {
  EXAMPLE_SELL_FORM,
  SELL_CURRENCIES,
  buildOrderRequestBody,
  emptySellForm,
  sellFieldError,
  sellPreviewSummary,
  validateSellForm,
  type SellField,
  type SellFormState,
  type SellValidation,
} from "../lib/checkout";
import {
  buildPlanReview,
  statusMessage,
  summarizeOutcomes,
  type ExecuteOutcomeWire,
} from "../lib/command";
import type { ActionPlan } from "../lib/types";

type Busy = "draft" | "approve" | "reject" | "execute" | null;

async function postJson(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function apiError(status: number, json: Record<string, unknown>, fallback: string): string {
  return typeof json.error === "string" ? json.error : `${fallback} (HTTP ${status})`;
}

const TEXT_FIELDS: Array<{ key: SellField; label: string; placeholder: string; width?: string }> = [
  { key: "description", label: "What are you selling?", placeholder: "Logo pack — five social templates" },
  { key: "amount", label: "Amount", placeholder: "75", width: "7rem" },
  { key: "reference", label: "Reference (optional)", placeholder: "LP-SALE-001" },
];

export default function SellForm({ onSettled }: { onSettled: () => void }) {
  const [form, setForm] = useState<SellFormState>(emptySellForm());
  const [validation, setValidation] = useState<SellValidation | null>(null);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const update = (patch: Partial<SellFormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const draft = useCallback(async () => {
    const result = validateSellForm(form);
    setValidation(result);
    if (!result.ok) {
      setError("Fix the highlighted fields first — the server validates again before drafting.");
      return;
    }
    setBusy("draft");
    setError(null);
    setOutcome(null);
    try {
      const body = buildOrderRequestBody(form);
      const { status, json } = await postJson("/api/paypal/orders", body as unknown as Record<string, unknown>);
      if (status !== 201) {
        setError(apiError(status, json, "Could not draft the checkout order"));
        return;
      }
      setPlan(json.plan as ActionPlan);
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to draft checkout order");
    } finally {
      setBusy(null);
    }
  }, [form, onSettled]);

  const decide = useCallback(
    async (decision: "approve" | "reject") => {
      if (!plan) return;
      setBusy(decision);
      setError(null);
      try {
        const { status, json } = await postJson("/api/agent/approve", { planId: plan.id, decision });
        if (status !== 200) {
          setError(apiError(status, json, `Could not ${decision} the plan`));
          return;
        }
        setPlan(json.plan as ActionPlan);
        onSettled();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${decision} plan`);
      } finally {
        setBusy(null);
      }
    },
    [plan, onSettled],
  );

  const execute = useCallback(async () => {
    if (!plan) return;
    setBusy("execute");
    setError(null);
    try {
      const { status, json } = await postJson("/api/agent/execute", { planId: plan.id });
      if (status !== 200) {
        setError(apiError(status, json, "Execution was refused"));
        return;
      }
      setPlan(json.plan as ActionPlan);
      setOutcome(summarizeOutcomes((json.outcomes ?? []) as ExecuteOutcomeWire[]));
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to execute plan");
    } finally {
      setBusy(null);
    }
  }, [plan, onSettled]);

  const review = plan ? buildPlanReview(plan) : null;

  return (
    <section className="command-bar sell-form" aria-label="Sell something">
      <h2>Sell something</h2>
      <p className="command-hint">
        Draft a checkout order for a one-off sale. Drafting creates no order — the order is
        created only after you approve the drafted plan, and its buyer checkout link then
        appears in the Orders grid above.
      </p>

      <div className="batch-lines">
        <div className="batch-line">
          {TEXT_FIELDS.map((f) => (
            <label key={f.key} className="batch-field">
              <span>{f.label}</span>
              <input
                className="command-input"
                style={f.width ? { width: f.width } : undefined}
                value={form[f.key]}
                placeholder={f.placeholder}
                aria-label={f.label}
                onChange={(e) => update({ [f.key]: e.target.value })}
              />
              {validation && sellFieldError(validation, f.key) && (
                <span className="batch-field-error">{sellFieldError(validation, f.key)}</span>
              )}
            </label>
          ))}
          <label className="batch-field">
            <span>Currency</span>
            <select
              className="command-input"
              value={form.currency}
              aria-label="Currency"
              onChange={(e) => update({ currency: e.target.value })}
            >
              {SELL_CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {validation && sellFieldError(validation, "currency") && (
              <span className="batch-field-error">{sellFieldError(validation, "currency")}</span>
            )}
          </label>
        </div>
      </div>

      <p className="batch-preview">{sellPreviewSummary(form)}</p>

      <div className="plan-actions">
        <button
          type="button"
          className="command-btn"
          onClick={() => {
            setForm({ ...EXAMPLE_SELL_FORM });
            setValidation(null);
            setError(null);
          }}
        >
          Load example sale
        </button>
        <button
          type="button"
          className="command-btn command-btn-primary"
          disabled={busy !== null}
          onClick={() => void draft()}
        >
          {busy === "draft" ? "Drafting…" : "Draft order plan"}
        </button>
      </div>

      {error && <p className="console-error">Sell form: {error}</p>}

      {review && (
        <div className="plan-review">
          <div className="plan-review-head">
            <span>
              Plan <strong>{review.planId}</strong>
            </span>
            <span className={`pill pill-${review.status.replace(/[^a-z]+/g, "-")}`}>{review.status}</span>
            <span className="plan-review-counts">
              {review.immediateCount} immediate · {review.gatedCount} trigger-gated
            </span>
          </div>
          <p className="plan-review-brief">“{review.brief}”</p>
          <ol className="plan-steps">
            {review.steps.map((s) => (
              <li key={s.index} className="plan-step">
                <span className="plan-step-type">{s.typeLabel}</span>
                <span className="plan-step-desc">{s.description}</span>
                <code className="plan-step-call">{s.callLabel}</code>
                {s.triggerLabel && <span className="plan-step-trigger">{s.triggerLabel}</span>}
              </li>
            ))}
          </ol>
          <p className="plan-status-message">{statusMessage(review.status)}</p>
          {outcome && <p className="plan-outcome">{outcome}</p>}
          <div className="plan-actions">
            {review.actions.canApprove && (
              <button type="button" className="command-btn command-btn-primary" disabled={busy !== null} onClick={() => void decide("approve")}>
                {busy === "approve" ? "Approving…" : "Approve"}
              </button>
            )}
            {review.actions.canReject && (
              <button type="button" className="command-btn command-btn-danger" disabled={busy !== null} onClick={() => void decide("reject")}>
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </button>
            )}
            {review.actions.canExecute && (
              <button type="button" className="command-btn command-btn-primary" disabled={busy !== null} onClick={() => void execute()}>
                {busy === "execute" ? "Executing…" : "Execute approved plan"}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
