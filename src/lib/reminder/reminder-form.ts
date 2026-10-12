/**
 * Reminder form — pure view-model logic for the console's "Send a
 * reminder" form (CONCEPT.md §1 AI component: AI-drafted payment
 * reminders; §3.1's typed action `send_reminder`).
 *
 * The structured data path is the only path this form uses, exactly
 * like the invoice form, the sell form, and the payout batch builder:
 *   POST /api/paypal/reminders { recipientName, recipientEmail?,
 *     invoiceRef? }
 *     → draftReminderPlan validates again server-side and drafts a
 *       `pending_approval` plan (nothing is sent)
 *   POST /api/agent/approve + /api/agent/execute
 *     → the ordinary approval gate resolves the target invoice
 *       (an explicit reference must match; with none, the recipient's
 *       most-overdue open invoice wins) and calls the real
 *       POST /v2/invoicing/invoices/:id/remind endpoint.
 *
 * Until this form existed, `send_reminder` was the one typed action
 * with no structured draft and no form — it was reachable only via a
 * natural-language reminder brief or the LLM fallback, while the
 * other three actions each had both. The validation here mirrors
 * the server's rules (src/lib/agent/drafts.ts) so the form can name
 * the failing field before the round-trip — it is a UX mirror, never
 * the enforcement point: the server re-validates and its errors
 * surface verbatim.
 */

const MAX_TEXT = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------ */
/* Form state                                                          */
/* ------------------------------------------------------------------ */

/** The reminder form. Every field is the raw input string. */
export interface ReminderFormState {
  recipientName: string;
  recipientEmail: string;
  invoiceRef: string;
}

export function emptyReminderForm(): ReminderFormState {
  return { recipientName: "", recipientEmail: "", invoiceRef: "" };
}

/** Fictional demo reminder only — the Command bar's canonical
 * reminder example ("Remind Marco about his overdue invoice"), which
 * against Judge Mode's seeded history resolves to Marco's
 * PARTIALLY_PAID overdue invoice. Loading the example must always
 * produce a body the real server validator accepts — the test suite
 * pins that against draftReminderPlan. */
export const EXAMPLE_REMINDER_FORM: ReminderFormState = {
  recipientName: "Marco",
  recipientEmail: "",
  invoiceRef: "",
};

/* ------------------------------------------------------------------ */
/* Validation (UX mirror of the server's draft rules)                  */
/* ------------------------------------------------------------------ */

export type ReminderField = "recipientName" | "recipientEmail" | "invoiceRef";

export interface ReminderFieldError {
  field: ReminderField;
  message: string;
}

export interface ReminderValidation {
  ok: boolean;
  errors: ReminderFieldError[];
}

export function validateReminderForm(form: ReminderFormState): ReminderValidation {
  const errors: ReminderFieldError[] = [];
  const push = (field: ReminderField, message: string) => errors.push({ field, message });

  const recipientName = form.recipientName.trim();
  if (!recipientName) push("recipientName", "'recipientName' is required and must be a non-empty string");
  else if (recipientName.length > MAX_TEXT) push("recipientName", `'recipientName' must be at most ${MAX_TEXT} characters`);

  const recipientEmail = form.recipientEmail.trim();
  if (recipientEmail) {
    if (recipientEmail.length > MAX_TEXT) push("recipientEmail", `'recipientEmail' must be at most ${MAX_TEXT} characters`);
    else if (!EMAIL_RE.test(recipientEmail)) push("recipientEmail", "'recipientEmail' must be a valid email address");
  }

  if (form.invoiceRef.trim().length > MAX_TEXT) push("invoiceRef", `'invoiceRef' must be at most ${MAX_TEXT} characters`);

  return { ok: errors.length === 0, errors };
}

/** First error message for one field, for inline rendering. */
export function reminderFieldError(validation: ReminderValidation, field: ReminderField): string | null {
  return validation.errors.find((e) => e.field === field)?.message ?? null;
}

/* ------------------------------------------------------------------ */
/* Request body + live preview                                         */
/* ------------------------------------------------------------------ */

export interface ReminderRequestBody {
  recipientName: string;
  recipientEmail?: string;
  invoiceRef?: string;
}

/**
 * Convert a validated form into the POST /api/paypal/reminders body.
 * Empty optional fields are omitted rather than sent as empty strings
 * (the server's optional-text rule would reject an empty string, and
 * an omitted invoiceRef is exactly how "most-overdue open invoice"
 * targeting is expressed).
 */
export function buildReminderRequestBody(form: ReminderFormState): ReminderRequestBody {
  const body: ReminderRequestBody = { recipientName: form.recipientName.trim() };
  const recipientEmail = form.recipientEmail.trim();
  if (recipientEmail) body.recipientEmail = recipientEmail;
  const invoiceRef = form.invoiceRef.trim();
  if (invoiceRef) body.invoiceRef = invoiceRef;
  return body;
}

/**
 * One-line live summary, e.g. "Remind Marco · most-overdue open
 * invoice" or "Remind Ana · about invoice LP-000123". The preview
 * states the targeting rule the executor will apply; it never claims
 * a specific invoice was resolved — resolution happens at execution.
 */
export function reminderPreviewSummary(form: ReminderFormState): string {
  const recipient = form.recipientName.trim() || "Unnamed recipient";
  const ref = form.invoiceRef.trim();
  return ref ? `Remind ${recipient} · about invoice ${ref}` : `Remind ${recipient} · most-overdue open invoice`;
}
