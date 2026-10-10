import type {
  CreateInvoiceInput,
  CreateOrderInput,
  CreatePayoutInput,
  Dispute,
  Invoice,
  Order,
  PayoutBatch,
  Transaction,
  WebhookEvent,
} from "../types";
import { PayPalNotConfiguredError, type PayPalClient } from "./client";

/**
 * Sandbox adapter — configuration boundary only (October, mock-first phase).
 *
 * This class intentionally does NOT contain credentials or network calls
 * yet: constructing it validates that the caller supplied their own sandbox
 * app credentials via env, and every operation fails loudly until the
 * sandbox integration milestone (blocked on the PayPal Developer account
 * decision, see CONCEPT.md §3.7 — hard deadline Oct 24) wires the REST
 * calls behind this exact interface. Mock mode is the supported path
 * until then, so nothing in the app depends on this class succeeding.
 */
export interface SandboxConfig {
  clientId?: string;
  clientSecret?: string;
  webhookId?: string;
  baseUrl?: string;
}

export class SandboxPayPalClient implements PayPalClient {
  readonly mode = "sandbox" as const;
  readonly baseUrl: string;

  constructor(config: SandboxConfig = {}) {
    const clientId = config.clientId ?? process.env.PAYPAL_CLIENT_ID;
    const clientSecret = config.clientSecret ?? process.env.PAYPAL_CLIENT_SECRET;
    const missing: string[] = [];
    if (!clientId) missing.push("PAYPAL_CLIENT_ID");
    if (!clientSecret) missing.push("PAYPAL_CLIENT_SECRET");
    if (missing.length > 0) throw new PayPalNotConfiguredError(missing);
    this.baseUrl = config.baseUrl ?? "https://api-m.sandbox.paypal.com";
  }

  private notYetWired(): never {
    throw new Error(
      "Sandbox REST integration is not wired yet (mock-first phase). Use PAYPAL_MODE=mock.",
    );
  }

  async createInvoice(_input: CreateInvoiceInput): Promise<Invoice> { return this.notYetWired(); }
  async sendInvoice(_id: string): Promise<Invoice> { return this.notYetWired(); }
  async getInvoice(_id: string): Promise<Invoice> { return this.notYetWired(); }
  async listInvoices(): Promise<Invoice[]> { return this.notYetWired(); }
  async recordInvoicePayment(_id: string, _a: { value: string; currency_code: string }): Promise<Invoice> { return this.notYetWired(); }
  async createOrder(_input: CreateOrderInput): Promise<Order> { return this.notYetWired(); }
  async captureOrder(_id: string): Promise<Order> { return this.notYetWired(); }
  async listOrders(): Promise<Order[]> { return this.notYetWired(); }
  async createPayout(_input: CreatePayoutInput): Promise<PayoutBatch> { return this.notYetWired(); }
  async listPayouts(): Promise<PayoutBatch[]> { return this.notYetWired(); }
  async listDisputes(): Promise<Dispute[]> { return this.notYetWired(); }
  async listTransactions(): Promise<Transaction[]> { return this.notYetWired(); }
  async verifyWebhookSignature(_h: Record<string, string>, _e: WebhookEvent): Promise<boolean> { return this.notYetWired(); }
}
