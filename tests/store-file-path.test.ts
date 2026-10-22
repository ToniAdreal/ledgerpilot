import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEDGER_STORE_FILE_ENV,
  LedgerStore,
  ledgerStoreFromEnv,
  normalizeLedgerStoreFilePath,
  parseBrief,
} from "@/lib/agent";
import {
  MOCK_PAYPAL_STORE_FILE_ENV,
  MockPayPalClient,
  getPayPalClient,
  normalizeMockStoreFilePath,
} from "@/lib/paypal";

// Saturday, Oct 10 2026 (UTC) — the demo-spine reference date.
const NOW = new Date("2026-10-10T12:00:00Z");

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledgerpilot-path-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("persistence file-path normalisation (ledger store)", () => {
  it("normalises missing, blank, and whitespace-only values to undefined", () => {
    expect(normalizeLedgerStoreFilePath(undefined)).toBeUndefined();
    expect(normalizeLedgerStoreFilePath(null)).toBeUndefined();
    expect(normalizeLedgerStoreFilePath("")).toBeUndefined();
    expect(normalizeLedgerStoreFilePath("   ")).toBeUndefined();
    expect(normalizeLedgerStoreFilePath(" \t\n ")).toBeUndefined();
  });

  it("trims a padded path and preserves an ordinary path exactly", () => {
    expect(normalizeLedgerStoreFilePath("  ./ledger.json  ")).toBe("./ledger.json");
    expect(normalizeLedgerStoreFilePath("./ledger.json")).toBe("./ledger.json");
    expect(normalizeLedgerStoreFilePath("/data/my ledger.json")).toBe("/data/my ledger.json");
  });

  it("constructor parity: a blank filePath is in-memory, not a file named by spaces", () => {
    expect(new LedgerStore({ filePath: "   " }).persistenceFile).toBeUndefined();
    expect(new LedgerStore({ filePath: "" }).persistenceFile).toBeUndefined();
    expect(new LedgerStore({}).persistenceFile).toBeUndefined();
  });

  it("constructor parity: a padded filePath is trimmed and persists to the trimmed path", () => {
    const dir = tempDir();
    const file = join(dir, "ledger.json");
    const store = new LedgerStore({ filePath: `  ${file}  ` });
    expect(store.persistenceFile).toBe(file);
    store.addPlan(parseBrief("Pay Marco $75", { now: NOW, planId: "plan-path-1" }));
    expect(existsSync(file)).toBe(true);
    const reopened = new LedgerStore({ filePath: file });
    expect(reopened.getPlan("plan-path-1")?.id).toBe("plan-path-1");
  });

  it("env helper and constructor agree on a padded value", () => {
    const dir = tempDir();
    const file = join(dir, "ledger.json");
    const fromEnv = ledgerStoreFromEnv({ [LEDGER_STORE_FILE_ENV]: `  ${file}  ` });
    expect(fromEnv.persistenceFile).toBe(file);
    expect(new LedgerStore({ filePath: `  ${file}  ` }).persistenceFile).toBe(file);
  });
});

describe("persistence file-path normalisation (mock adapter)", () => {
  it("normalises missing, blank, and whitespace-only values to undefined", () => {
    expect(normalizeMockStoreFilePath(undefined)).toBeUndefined();
    expect(normalizeMockStoreFilePath(null)).toBeUndefined();
    expect(normalizeMockStoreFilePath("")).toBeUndefined();
    expect(normalizeMockStoreFilePath("   ")).toBeUndefined();
    expect(normalizeMockStoreFilePath(" \t\n ")).toBeUndefined();
  });

  it("trims a padded path and preserves an ordinary path exactly", () => {
    expect(normalizeMockStoreFilePath("  ./mock.json  ")).toBe("./mock.json");
    expect(normalizeMockStoreFilePath("./mock.json")).toBe("./mock.json");
    expect(normalizeMockStoreFilePath("/data/my mock.json")).toBe("/data/my mock.json");
  });

  it("constructor parity: a blank filePath is in-memory, not a file named by spaces", () => {
    expect(new MockPayPalClient({ filePath: "   " }).persistenceFile).toBeUndefined();
    expect(new MockPayPalClient({ filePath: "" }).persistenceFile).toBeUndefined();
    expect(new MockPayPalClient({}).persistenceFile).toBeUndefined();
  });

  it("constructor parity: a padded filePath is trimmed and persists to the trimmed path", async () => {
    const dir = tempDir();
    const file = join(dir, "mock.json");
    const client = new MockPayPalClient({ filePath: `  ${file}  ` });
    expect(client.persistenceFile).toBe(file);
    await client.createInvoice({
      recipient: { name: "Ana", email_address: "ana@example.com" },
      items: [
        {
          name: "Logo work",
          quantity: "1",
          unit_amount: { currency_code: "USD", value: "10.00" },
        },
      ],
    });
    expect(existsSync(file)).toBe(true);
    const reopened = new MockPayPalClient({ filePath: file });
    expect((await reopened.listInvoices()).length).toBe(1);
  });

  it("factory and constructor agree on a padded value", () => {
    const dir = tempDir();
    const file = join(dir, "mock.json");
    const fromFactory = getPayPalClient({
      [MOCK_PAYPAL_STORE_FILE_ENV]: `  ${file}  `,
    }) as MockPayPalClient;
    expect(fromFactory.persistenceFile).toBe(file);
    expect(new MockPayPalClient({ filePath: `  ${file}  ` }).persistenceFile).toBe(file);
  });
});
