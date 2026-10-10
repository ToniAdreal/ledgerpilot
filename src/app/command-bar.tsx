"use client";

/**
 * Agent Command bar — the console surface for the full agent loop:
 * write a plain-English brief → review the typed plan (exact PayPal
 * calls, trigger-gated steps marked) → approve or reject → execute.
 *
 * This component never calls PayPal itself; it drives the existing
 * /api/agent/* routes, and the server-side approval gate remains the
 * enforcement point. All presentation rules (which actions a status
 * allows, how steps render) come from src/lib/command so they are
 * unit-tested. After an execution settles, `onSettled` refreshes the
 * KPI strip and the four grids.
 */

import { useCallback, useEffect, useState } from "react";
import {
  EXAMPLE_BRIEFS,
  buildPlanReview,
  pendingPlans,
  statusMessage,
  summarizeOutcomes,
  validateBrief,
  type ExecuteOutcomeWire,
} from "../lib/command";
import type { ActionPlan } from "../lib/types";

type Busy = "draft" | "approve" | "reject" | "execute" | null;

async function postJson(path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
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

export default function CommandBar({ onSettled }: { onSettled: () => void }) {
  const [brief, setBrief] = useState("");
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [pending, setPending] = useState<ActionPlan[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/plan");
      const json = (await res.json()) as { plans?: ActionPlan[] };
      setPending(pendingPlans(json.plans ?? []));
    } catch {
      /* the queue is a convenience; drafting still works without it */
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const draft = useCallback(async () => {
    const validation = validateBrief(brief);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setBusy("draft");
    setError(null);
    setOutcome(null);
    try {
      const { status, json } = await postJson("/api/agent/plan", { brief: validation.brief });
      if (status !== 201) {
        setError(apiError(status, json, "Could not draft a plan from that brief"));
        return;
      }
      setPlan(json.plan as ActionPlan);
      await loadPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to draft plan");
    } finally {
      setBusy(null);
    }
  }, [brief, loadPending]);

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
        await loadPending();
        onSettled();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${decision} plan`);
      } finally {
        setBusy(null);
      }
    },
    [plan, loadPending, onSettled],
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
      await loadPending();
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to execute plan");
    } finally {
      setBusy(null);
    }
  }, [plan, loadPending, onSettled]);

  const review = plan ? buildPlanReview(plan) : null;

  return (
    <section className="command-bar" aria-label="Agent Command">
      <h2>Agent Command</h2>
      <p className="command-hint">
        Describe the money movement in plain English. The agent drafts a typed plan — nothing
        executes until you approve it.
      </p>
      <div className="command-input-row">
        <textarea
          className="command-input"
          rows={2}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco."
          aria-label="Agent brief"
        />
        <button type="button" className="command-btn command-btn-primary" disabled={busy !== null} onClick={() => void draft()}>
          {busy === "draft" ? "Drafting…" : "Draft plan"}
        </button>
      </div>
      <div className="example-chips">
        {EXAMPLE_BRIEFS.map((ex) => (
          <button key={ex.label} type="button" className="example-chip" onClick={() => setBrief(ex.brief)}>
            {ex.label}
          </button>
        ))}
      </div>

      {pending.length > 0 && (
        <p className="pending-queue">
          Waiting for your decision:{" "}
          {pending.map((p) => (
            <button
              key={p.id}
              type="button"
              className="pending-chip"
              onClick={() => {
                setPlan(p);
                setError(null);
                setOutcome(null);
              }}
            >
              {p.id} — {p.steps.length} step{p.steps.length === 1 ? "" : "s"}
            </button>
          ))}
        </p>
      )}

      {error && <p className="console-error">Command failed: {error}</p>}

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
