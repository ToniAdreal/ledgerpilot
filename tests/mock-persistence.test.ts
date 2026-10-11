import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LedgerStore,
  executePlan,
  parseBrief,
  syncFromPayPal,
} from "@/lib/agent";
import {
  MOCK_PAYPAL_SNAPSHOT_VERSION,
  MOCK_PAYPAL_STORE_FILE_ENV,
  MockPayPalClient,
  MockPayPalPersistenceError,
  getPayPalClient,
} from "@/lib/paypal";

// Saturday, Oct 10 2026 (UTC) — the demo-spine reference date.
const NOW = new Date("2026-10-10T12:00:00Z");
const DEMO_BRIEF =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";
const ANA = { name: "Ana", email_address: "ana@example.com" };
const MARCO = { name: "Marco", email_address: "marco@example.com" };

const dirs: string[] = [];
function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ledgerpilot-mock-"));
  dirs.push(dir);
  return join(dir, "nested", name);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("mock PayPal persistence (opt-in file snapshot)", () => {
  it("is in-memory by default and via a blank env var — no file is created", () => {
    expect(new MockPayPalClient().persistenceFile).toBeUndefined();
    const fromFactory = getPayPalClient({}) as MockPayPalClient;
    expect(fromFactory.persistenceFile).toBeUndefined();
    const blank = getPayPalClient({ [MOCK_PAYPAL_STORE_FILE_ENV]: "   " }) as MockPayPalClient;
    expect(blank.persistenceFile).toBeUndefined();
  });

  it("the factory returns a file-backed mock client when the env var is set", async () => {
    const file = tempFile("mock.mock-paypal.json");
    const client = getPayPalClient({ [MOCK_PAYPAL_STORE_FILE_ENV]: file }) as MockPayPalClient;
    expect(client.persistenceFile).toBe(file);
    await client.createInvoice({
      recipient: ANA,
      items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "10.00" } }],
    });
    expect(existsSync(file)).toBe(true);
  });

  it("restores invoices, orders, payouts, transactions, events, reminders, and disputes after a restart", async () => {
    const file = tempFile("mock.mock-paypal.json");
    const first = new MockPayPalClient({ filePath: file });
    const draft = await first.createInvoice({
      recipient: ANA,
      items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
      dueDate: "2026-10-16",
    });
    await first.sendInvoice(draft.id);
    await first.sendInvoiceReminder(draft.id, { note: "friendly nudge" });
    const order = await first.createOrder({
      description: "Studio cable pack",
      amount: { currency_code: "USD", value: "59.00" },
    });
    await first.captureOrder(order.id);
    await first.createPayout({
      items: [{ recipient: MARCO, amount: { currency_code: "USD", value: "80.00" }, note: "Hosting help" }],
    });
    const eventIdsBefore = first.emittedEvents.map((e) => e.id);

    // Restart: a brand-new client over the same file.
    const reopened = new MockPayPalClient({ filePath: file });
    const invoices = await reopened.listInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.id).toBe(draft.id);
    expect(invoices[0]?.status).toBe("SENT");
    const orders = await reopened.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe("COMPLETED");
    const payouts = await reopened.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.items[0]?.transaction_status).toBe("SUCCESS");
    // 1 capture + 1 payout transaction; the unpaid invoice adds none.
    expect(await reopened.listTransactions()).toHaveLength(2);
    expect(reopened.emittedEvents.map((e) => e.id)).toEqual(eventIdsBefore);
    expect(reopened.sentReminders).toHaveLength(1);
    expect(reopened.sentReminders[0]?.note).toBe("friendly nudge");
    // The sample dispute is restored from the snapshot, not duplicated.
    const disputes = await reopened.listDisputes();
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.sample).toBe(true);
  });

  it("continues the id sequence after a restart — new ids never collide with restored ones", async () => {
    const file = tempFile("mock.mock-paypal.json");
    const first = new MockPayPalClient({ filePath: file });
    const a = await first.createInvoice({
      recipient: ANA,
      items: [{ name: "One", quantity: "1", unit_amount: { currency_code: "USD", value: "10.00" } }],
    });
    const reopened = new MockPayPalClient({ filePath: file });
    const b = await reopened.createInvoice({
      recipient: ANA,
      items: [{ name: "Two", quantity: "1", unit_amount: { currency_code: "USD", value: "20.00" } }],
    });
    expect(b.id).not.toBe(a.id);
    const ids = (await reopened.listInvoices()).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("writes a versioned, valid-JSON snapshot atomically (no temp file left behind)", async () => {
    const file = tempFile("mock.mock-paypal.json");
    const client = new MockPayPalClient({ filePath: file });
    await client.createOrder({ description: "Pack", amount: { currency_code: "USD", value: "5.00" } });
    const snap = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      invoices: unknown[];
      orders: unknown[];
      disputes: unknown[];
    };
    expect(snap.version).toBe(MOCK_PAYPAL_SNAPSHOT_VERSION);
    expect(snap.orders).toHaveLength(1);
    expect(snap.disputes).toHaveLength(1);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("refuses a corrupt snapshot loudly and leaves the file untouched", async () => {
    const file = tempFile("mock.mock-paypal.json");
    const client = new MockPayPalClient({ filePath: file });
    await client.createOrder({ description: "Pack", amount: { currency_code: "USD", value: "5.00" } });
    writeFileSync(file, "{ not json", "utf8");
    expect(() => new MockPayPalClient({ filePath: file })).toThrow(MockPayPalPersistenceError);
    expect(() => new MockPayPalClient({ filePath: file })).toThrow(/corrupt mock history/);
    expect(readFileSync(file, "utf8")).toBe("{ not json"); // never silently reseeded over
  });

  it("refuses an unsupported snapshot version", async () => {
    const file = tempFile("mock.mock-paypal.json");
    const client = new MockPayPalClient({ filePath: file });
    await client.createOrder({ description: "Pack", amount: { currency_code: "USD", value: "5.00" } });
    const snap = JSON.parse(readFileSync(file, "utf8")) as { version: number };
    snap.version = 999;
    writeFileSync(file, JSON.stringify(snap), "utf8");
    expect(() => new MockPayPalClient({ filePath: file })).toThrow(/unsupported or malformed snapshot/);
  });

  it("closes the full loop across a real restart when both stores are file-backed", async () => {
    const mockFile = tempFile("mock.mock-paypal.json");
    const ledgerFile = tempFile("ledger.ledger.json");

    // First process: draft, approve, execute — invoice SENT, payout gated.
    const client1 = new MockPayPalClient({ filePath: mockFile });
    const store1 = new LedgerStore({ filePath: ledgerFile });
    const plan = store1.addPlan(parseBrief(DEMO_BRIEF, { now: NOW, planId: "plan-restart-1" }));
    store1.approvePlan(plan.id);
    const executed = await executePlan(store1, client1, plan.id);
    expect(executed.plan.status).toBe("awaiting_trigger");
    const invoiceId = executed.outcomes[0]?.resultId;
    expect(invoiceId).toBeTruthy();

    // Restart: brand-new client + store over the same two files.
    const client2 = new MockPayPalClient({ filePath: mockFile });
    const store2 = new LedgerStore({ filePath: ledgerFile });
    expect(store2.getPlan(plan.id)?.status).toBe("awaiting_trigger");
    const restoredInvoice = await client2.getInvoice(invoiceId!);
    expect(restoredInvoice.status).toBe("SENT");

    // The buyer pays on the restarted instance; sync resumes the payout.
    await client2.recordInvoicePayment(invoiceId!, { value: "450.00", currency_code: "USD" });
    const sync = await syncFromPayPal(store2, client2);
    expect(sync.resumed.map((r) => r.plan.id)).toContain(plan.id);
    expect(store2.getPlan(plan.id)?.status).toBe("completed");
    const payouts = await client2.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.items[0]?.payout_item.amount.value).toBe("200.00");
    const txnValues = (await client2.listTransactions()).map((t) => t.transaction_amount.value);
    expect(txnValues).toContain("450.00");
    expect(txnValues).toContain("-200.00");
  });
});
