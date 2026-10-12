"use client";

/**
 * Reminder form — the console form for CONCEPT.md §1's payment
 * reminders (the typed action `send_reminder`).
 *
 * The form never calls PayPal and never sends a reminder: it POSTs
 * the reminder to /api/paypal/reminders, which validates again
 * server-side and drafts a `pending_approval` plan. The plan review
 * below (exact PayPal call) and the Approve / Execute buttons are
 * the same gate the Agent Command bar, the invoice form, the sell
 * form, and the batch builder use — the reminder is sent only
 * through /api/agent/approve + /api/agent/execute, after which the
 * send appears in the Activity audit grid. All form rules live in
 * src/lib/reminder/reminder-form.ts so they are unit-tested; this
 * component is a thin shell over them.
 */

import { useCallback, useState } from "react";
import {
  EXAMPLE_REMINDER_FORM,
  buildReminderRequestBody,
  emptyReminderForm,
  reminderFieldError,
  reminderPreviewSummary,
  validateReminderForm,
  type ReminderField,
  type ReminderFormState,
  type ReminderValidation,
} from "../lib/reminder";
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

const TEXT_FIELDS: Array<{ key: ReminderField; label: string; placeholder: string }> = [
  { key: "recipientName", label: "Recipient", placeholder: "Marco" },
  { key: "recipientEmail", label: "Recipient email (optional)", placeholder: "marco@example.com" },
  { key: "invoiceRef", label: "Invoice reference (optional)", placeholder: "LP-000123" },
];

export default function ReminderForm({ onSettled }: { onSettled: () => void }) {
  const [form, setForm] = useState<ReminderFormState>(emptyReminderForm());
  const [validation, setValidation] = useState<ReminderValidation | null>(null);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const update = (patch: Partial<ReminderFormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const draft = useCallback(async () => {
    const result = validateReminderForm(form);
    setValidation(result);
    if (!result.ok) {
      setError("Fix the highlighted fields first — the server validates again before drafting.");
      return;
    }
    setBusy("draft");
    setError(null);
    setOutcome(null);
    try {
      const body = buildReminderRequestBody(form);
      const { status, json } = await postJson("/api/paypal/reminders", body as unknown as Record<string, unknown>);
      if (status !== 201) {
        setError(apiError(status, json, "Could not draft the reminder"));
        return;
      }
      setPlan(json.plan as ActionPlan);
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to draft reminder");
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
    <section className="command-bar reminder-form" aria-label="Send a reminder">
      <h2>Send a reminder</h2>
      <p className="command-hint">
        Draft a payment reminder for a client with an open invoice. Drafting sends no
        reminder — it is sent only after you approve the drafted plan. Leave the invoice
        reference empty to target the recipient&apos;s most-overdue open invoice, or name
        one invoice by id, number, or reference.
      </p>

      <div className="batch-lines">
        <div className="batch-line">
          {TEXT_FIELDS.map((f) => (
            <label key={f.key} className="batch-field">
              <span>{f.label}</span>
              <input
                className="command-input"
                value={form[f.key]}
                placeholder={f.placeholder}
                aria-label={f.label}
                onChange={(e) => update({ [f.key]: e.target.value })}
              />
              {validation && reminderFieldError(validation, f.key) && (
                <span className="batch-field-error">{reminderFieldError(validation, f.key)}</span>
              )}
            </label>
          ))}
        </div>
      </div>

      <p className="batch-preview">{reminderPreviewSummary(form)}</p>

      <div className="plan-actions">
        <button
          type="button"
          className="command-btn"
          onClick={() => {
            setForm({ ...EXAMPLE_REMINDER_FORM });
            setValidation(null);
            setError(null);
          }}
        >
          Load example reminder
        </button>
        <button
          type="button"
          className="command-btn command-btn-primary"
          disabled={busy !== null}
          onClick={() => void draft()}
        >
          {busy === "draft" ? "Drafting…" : "Draft reminder plan"}
        </button>
      </div>

      {error && <p className="console-error">Reminder form: {error}</p>}

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
