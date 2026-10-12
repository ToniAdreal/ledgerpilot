import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { executePlan } from "../src/lib/agent/executor";
import { draftInvoicePlan } from "../src/lib/agent/drafts";
import {
  EXAMPLE_INVOICE_FORM,
  buildInvoiceRequestBody,
  emptyInvoiceForm,
  invoiceFieldError,
  invoicePreviewSummary,
  parseInvoiceAmount,
  validateInvoiceForm,
} from "../src/lib/invoice";
import { buildInvoiceRows } from "../src/lib/console/read-models";

/**
 * Invoice form (CONCEPT.md §3.1 "/invoices" + §3.2 step 2) — the
 * console UI chunk on top of the invoices draft data path
 * (tests/api-drafts.test.ts).
 *
 * These tests pin the form's pure view-model: the validation mirror
 * (same rules the server enforces in draftInvoicePlan, including the
 * real-calendar due-date rule), request-body building, the live
 * preview, and — the guarantee that matters — a body built from the
 * form (example included) is accepted by the real draftInvoicePlan
 * and executes through the approval gate into a SENT invoice.
 */

const VALID_FORM = {
  recipientName: "Ana",
  recipientEmail: "",
  description: "Brand work",
  amount: "450",
  currency: "USD",
  dueDate: "2026-10-16",
  note: "",
  reference: "",
};

describe("invoice form — state + amount parsing", () => {
  it("starts empty with a USD default and parses amounts like the server", () => {
    expect(emptyInvoiceForm()).toEqual({
      recipientName: "",
      recipientEmail: "",
      description: "",
      amount: "",
      currency: "USD",
      dueDate: "",
      note: "",
      reference: "",
    });
    expect(parseInvoiceAmount("1,200")).toBe(1200);
    expect(parseInvoiceAmount(" 450.5 ")).toBe(450.5);
    expect(parseInvoiceAmount("")).toBeNull();
    expect(parseInvoiceAmount("abc")).toBeNull();
  });
});

describe("invoice form — validation mirror", () => {
  it("accepts a valid form, including comma amounts, lowercase currency, and an explicit email", () => {
    const v = validateInvoiceForm({ ...VALID_FORM, amount: "1,200", currency: "eur", recipientEmail: "ana@example.com" });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("names the failing field for every rule the server enforces", () => {
    const v = validateInvoiceForm({
      recipientName: " ",
      recipientEmail: "not-an-email",
      description: "",
      amount: "0",
      currency: "JPY",
      dueDate: "16/10/2026",
      note: "x".repeat(501),
      reference: "x".repeat(501),
    });
    expect(v.ok).toBe(false);
    expect(invoiceFieldError(v, "recipientName")).toMatch(/'recipientName' is required/);
    expect(invoiceFieldError(v, "recipientEmail")).toMatch(/valid email address/);
    expect(invoiceFieldError(v, "description")).toMatch(/'description' is required/);
    expect(invoiceFieldError(v, "amount")).toMatch(/greater than zero/);
    expect(invoiceFieldError(v, "currency")).toMatch(/one of USD, EUR, GBP/);
    expect(invoiceFieldError(v, "dueDate")).toMatch(/ISO date/);
    expect(invoiceFieldError(v, "note")).toMatch(/at most 500/);
    expect(invoiceFieldError(v, "reference")).toMatch(/at most 500/);

    expect(invoiceFieldError(validateInvoiceForm({ ...VALID_FORM, amount: "" }), "amount")).toMatch(/is required/);
    expect(invoiceFieldError(validateInvoiceForm({ ...VALID_FORM, amount: "abc" }), "amount")).toMatch(/must be a number/);
    expect(invoiceFieldError(validateInvoiceForm({ ...VALID_FORM, amount: "100001" }), "amount")).toMatch(/must not exceed 100000/);
    expect(invoiceFieldError(validateInvoiceForm({ ...VALID_FORM, recipientName: "x".repeat(501) }), "recipientName")).toMatch(/at most 500/);
    expect(invoiceFieldError(validateInvoiceForm(VALID_FORM), "amount")).toBeNull();
  });

  it("rejects an impossible calendar due date exactly like the server, and accepts a leap day", () => {
    expect(invoiceFieldError(validateInvoiceForm({ ...VALID_FORM, dueDate: "2026-02-30" }), "dueDate")).toMatch(
      /real calendar date/,
    );
    expect(validateInvoiceForm({ ...VALID_FORM, dueDate: "2028-02-29" }).ok).toBe(true);
    expect(validateInvoiceForm({ ...VALID_FORM, dueDate: "" }).ok).toBe(true);
  });
});

describe("invoice form — request body + preview", () => {
  it("builds the server body: numbers parsed, currency normalised, empty optionals omitted", () => {
    expect(buildInvoiceRequestBody({ ...VALID_FORM, amount: "1,200", currency: "usd" })).toEqual({
      recipientName: "Ana",
      amount: 1200,
      currency: "USD",
      description: "Brand work",
      dueDate: "2026-10-16",
    });
    expect(
      buildInvoiceRequestBody({
        recipientName: " Marco ",
        recipientEmail: " marco@example.com ",
        description: " Hosting help ",
        amount: "59.5",
        currency: "eur",
        dueDate: "",
        note: " Thanks ",
        reference: " LP-000123 ",
      }),
    ).toEqual({
      recipientName: "Marco",
      amount: 59.5,
      currency: "EUR",
      description: "Hosting help",
      recipientEmail: "marco@example.com",
      note: "Thanks",
      reference: "LP-000123",
    });
  });

  it("preview names recipient, amount, work, and due date; invalid amounts are never guessed", () => {
    expect(invoicePreviewSummary(VALID_FORM)).toBe("Invoice Ana · USD 450.00 for Brand work, due 2026-10-16");
    expect(invoicePreviewSummary(emptyInvoiceForm())).toBe("Invoice Unnamed recipient · no amount yet");
    expect(invoicePreviewSummary({ ...VALID_FORM, amount: "abc" })).toBe("Invoice Ana · no amount yet");
    expect(invoicePreviewSummary({ ...VALID_FORM, amount: "0" })).toBe("Invoice Ana · no amount yet");
    expect(invoicePreviewSummary({ ...VALID_FORM, dueDate: "2026-02-30" })).toBe(
      "Invoice Ana · USD 450.00 for Brand work",
    );
  });

  it("the example invoice validates and its body is accepted by the real server draft", () => {
    expect(validateInvoiceForm(EXAMPLE_INVOICE_FORM).ok).toBe(true);
    const plan = draftInvoicePlan(buildInvoiceRequestBody(EXAMPLE_INVOICE_FORM));
    expect(plan.status).toBe("pending_approval");
    expect(plan.source).toBe("api");
    expect(plan.steps[0]!.type).toBe("create_invoice");
    expect(plan.steps[0]!.paypalCall).toEqual({ method: "POST", path: "/v2/invoicing/invoices (+ /send)" });
    expect(plan.steps[0]!.payload).toMatchObject({
      dueDate: "2026-10-16",
      items: [{ name: "Brand work", unit_amount: { currency_code: "USD", value: "450.00" } }],
    });
  });
});

describe("invoice form — full loop through the gate", () => {
  it("a form-built draft refuses unapproved execution, then creates and sends the invoice", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = store.addPlan(draftInvoicePlan(buildInvoiceRequestBody(EXAMPLE_INVOICE_FORM)));

    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/approval/);
    const seededCount = (await client.listInvoices()).length;

    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");
    const invoices = await client.listInvoices();
    expect(invoices).toHaveLength(seededCount + 1);
    const created = invoices.find((i) => i.amount.value === "450.00" && i.status === "SENT");
    expect(created).toBeDefined();
    expect(created!.detail.payment_term?.due_date).toBe("2026-10-16");

    const rows = buildInvoiceRows(invoices, "2026-10-10");
    const row = rows.find((r) => r.id === created!.id);
    expect(row).toMatchObject({ status: "SENT", dueDate: "2026-10-16" });
  });
});
