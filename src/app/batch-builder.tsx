"use client";

/**
 * Payout batch builder — the console form for CONCEPT.md §3.1's
 * "payout batch builder: agent-drafted batch, per-line validation,
 * approval release".
 *
 * The form never calls PayPal and never moves money: it POSTs the
 * batch to /api/paypal/payouts, which validates every line again
 * server-side and drafts a `pending_approval` plan. The plan review
 * below (exact PayPal call, trigger badge) and the Approve / Execute
 * buttons are the same gate the Agent Command bar uses — the batch is
 * released only through /api/agent/approve + /api/agent/execute, as
 * exactly one Payouts batch. All form rules live in src/lib/batch so
 * they are unit-tested; this component is a thin shell over them.
 */

import { useCallback, useState } from "react";
import {
  BATCH_CURRENCIES,
  EXAMPLE_BATCH_LINES,
  addBatchLine,
  batchPreviewSummary,
  buildBatchRequestBody,
  canAddLine,
  canRemoveLine,
  emptyBatchLine,
  lineFieldError,
  removeBatchLine,
  updateBatchLine,
  validateBatchForm,
  type BatchLineField,
  type BatchLineForm,
  type BatchValidation,
} from "../lib/batch";
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

const LINE_FIELDS: Array<{ key: keyof BatchLineForm; label: string; placeholder: string; width?: string }> = [
  { key: "recipientName", label: "Recipient", placeholder: "Marco" },
  { key: "recipientEmail", label: "Email (optional)", placeholder: "marco@example.com" },
  { key: "amount", label: "Amount", placeholder: "200", width: "7rem" },
  { key: "note", label: "Note (optional)", placeholder: "Brand work share" },
];

export default function BatchBuilder({ onSettled }: { onSettled: () => void }) {
  const [lines, setLines] = useState<BatchLineForm[]>([emptyBatchLine()]);
  const [batchNote, setBatchNote] = useState("");
  const [gateInvoiceId, setGateInvoiceId] = useState("");
  const [validation, setValidation] = useState<BatchValidation | null>(null);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const draft = useCallback(async () => {
    const result = validateBatchForm(lines, { note: batchNote, payWhenInvoicePaid: gateInvoiceId });
    setValidation(result);
    if (!result.ok) {
      setError("Fix the highlighted lines first — the server validates every line again before drafting.");
      return;
    }
    setBusy("draft");
    setError(null);
    setOutcome(null);
    try {
      const body = buildBatchRequestBody(lines, { note: batchNote, payWhenInvoicePaid: gateInvoiceId });
      const { status, json } = await postJson("/api/paypal/payouts", body as unknown as Record<string, unknown>);
      if (status !== 201) {
        setError(apiError(status, json, "Could not draft the payout batch"));
        return;
      }
      setPlan(json.plan as ActionPlan);
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to draft payout batch");
    } finally {
      setBusy(null);
    }
  }, [lines, batchNote, gateInvoiceId, onSettled]);

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
  const formErrors = validation && !validation.ok ? validation.errors.filter((e) => e.lineIndex === null) : [];

  return (
    <section className="command-bar batch-builder" aria-label="Payout batch builder">
      <h2>Payout batch builder</h2>
      <p className="command-hint">
        Build a multi-recipient payout batch line by line. Drafting moves no money — the batch is
        released as one PayPal Payouts batch only after you approve the drafted plan.
      </p>

      <div className="batch-lines">
        {lines.map((line, i) => (
          <div key={i} className="batch-line">
            <span className="batch-line-num">{i + 1}</span>
            {LINE_FIELDS.map((f) => (
              <label key={f.key} className="batch-field">
                <span>{f.label}</span>
                <input
                  className="command-input"
                  style={f.width ? { width: f.width } : undefined}
                  value={line[f.key]}
                  placeholder={f.placeholder}
                  aria-label={`Line ${i + 1} ${f.label}`}
                  onChange={(e) => setLines((prev) => updateBatchLine(prev, i, { [f.key]: e.target.value }))}
                />
                {validation && lineFieldError(validation, i, f.key as BatchLineField) && (
                  <span className="batch-field-error">{lineFieldError(validation, i, f.key as BatchLineField)}</span>
                )}
              </label>
            ))}
            <label className="batch-field">
              <span>Currency</span>
              <select
                className="command-input"
                value={line.currency}
                aria-label={`Line ${i + 1} Currency`}
                onChange={(e) => setLines((prev) => updateBatchLine(prev, i, { currency: e.target.value }))}
              >
                {BATCH_CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="command-btn batch-remove-btn"
              disabled={!canRemoveLine(lines.length)}
              onClick={() => setLines((prev) => removeBatchLine(prev, i))}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="batch-meta">
        <label className="batch-field">
          <span>Batch note (optional)</span>
          <input
            className="command-input"
            value={batchNote}
            placeholder="October contractor run"
            aria-label="Batch note"
            onChange={(e) => setBatchNote(e.target.value)}
          />
        </label>
        <label className="batch-field">
          <span>Release only when this invoice is paid (optional)</span>
          <input
            className="command-input"
            value={gateInvoiceId}
            placeholder="INV2-000001"
            aria-label="Gate invoice id"
            onChange={(e) => setGateInvoiceId(e.target.value)}
          />
        </label>
      </div>

      {formErrors.length > 0 && (
        <p className="console-error">{formErrors.map((e) => e.message).join(" · ")}</p>
      )}
      <p className="batch-preview">{batchPreviewSummary(lines, { payWhenInvoicePaid: gateInvoiceId })}</p>

      <div className="plan-actions">
        <button
          type="button"
          className="command-btn"
          disabled={!canAddLine(lines.length)}
          onClick={() => setLines((prev) => addBatchLine(prev))}
        >
          Add line
        </button>
        <button
          type="button"
          className="command-btn"
          onClick={() => {
            setLines(EXAMPLE_BATCH_LINES.map((l) => ({ ...l })));
            setValidation(null);
            setError(null);
          }}
        >
          Load example batch
        </button>
        <button
          type="button"
          className="command-btn command-btn-primary"
          disabled={busy !== null}
          onClick={() => void draft()}
        >
          {busy === "draft" ? "Drafting…" : "Draft batch plan"}
        </button>
      </div>

      {error && <p className="console-error">Batch builder: {error}</p>}

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
