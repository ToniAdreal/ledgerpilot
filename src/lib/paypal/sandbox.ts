import type {
  CreateInvoiceInput,
  CreateOrderInput,
  CreatePayoutInput,
  Dispute,
  Invoice,
  Money,
  Order,
  Party,
  PayoutBatch,
  SendInvoiceReminderInput,
  Transaction,
  WebhookEvent,
} from "../types";
import { PayPalError, PayPalNotConfiguredError, type PayPalClient } from "./client";

/**
 * Sandbox adapter — live PayPal REST wiring behind the PayPalClient
 * contract (Invoicing v2, Orders v2, Payouts, Disputes, Transaction
 * Search, webhook verification).
 *
 * Credential rules are unchanged: the constructor requires the caller's
 * OWN sandbox app credentials (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET,
 * optionally PAYPAL_WEBHOOK_ID) and throws PayPalNotConfiguredError
 * without them. No credential is stored in code, and mock mode remains
 * the default everywhere — this adapter only runs when
 * PAYPAL_MODE=sandbox is explicitly selected.
 *
 * Testability: the HTTP layer is injectable (`fetchFn`), as is the clock
 * (`now`), so the full REST surface — OAuth token fetch + caching,
 * request/response mapping, and PayPal error translation — is unit
 * tested against a stub fetch with fake credentials. Nothing in those
 * tests touches the network or a real PayPal account. The adapter has
 * NOT yet been exercised against the live sandbox: that happens once
 * the PayPal Developer account exists (see BUILD_LOG BLOCKERS,
 * hard deadline Oct 24).
 *
 * Known PayPal API shapes this adapter is honest about:
 * - Create-invoice returns 201 with HATEOAS links and no resource body,
 *   so the invoice id is read from the `self` link and the invoice is
 *   then fetched with GET. (A response that does carry an id is used
 *   directly.)
 * - Orders v2 has NO list endpoint. The adapter remembers the ids of
 *   orders it created in this process and lists by GET-ing each one.
 *   Orders created outside this process are therefore not listed —
 *   the same process-scoping the mock adapter has.
 * - Payout batch responses do not return recipient display names (only
 *   the receiver email). Batches created by this process keep the
 *   recipient names supplied at creation; batches only fetched are
 *   reconstructed with the receiver email as the display name.
 * - Transaction Search requires a date window (max 31 days); the
 *   adapter queries the trailing 30 days from `now`.
 *
 * Request timeout: every PayPal call this adapter makes — the OAuth
 * token fetch included — is bounded by a per-request timeout
 * (`SANDBOX_REQUEST_TIMEOUT_MS`, 10 seconds by default, the same
 * bound the LLM adapter enforces on its outbound calls). Until this
 * bound existed, a PayPal endpoint that accepted the connection and
 * never answered would hang the calling route — an invoice send, a
 * payout, a webhook verification — indefinitely, with the eventual
 * failure surfacing only as the host's own opaque timeout. A call
 * that exceeds the bound is aborted and translated into a
 * `PayPalError` with status 504 and name `REQUEST_TIMEOUT`, naming
 * the timeout and the request (method + path, never a credential),
 * so callers and the audit log see the same error shape as any other
 * PayPal failure. This bound translates the one failure it causes;
 * the remaining transport failure — no response at all — is
 * translated separately, below.
 *
 * The bound spans the whole call, not just the response headers:
 * the timer stays armed while the response body is being read
 * (`fetchAndRead` below), so an endpoint that answers its headers
 * promptly and then drips — or never finishes — its body is aborted
 * and translated exactly like a call that never answered. Until the
 * timer spanned the body, that slow-drip case hung the calling
 * route with the headers already in hand, outside the bound the
 * timeout claimed to set.
 *
 * Connection failure: the timeout covers a call that never answers
 * in time; this case covers a call that gets no response at all —
 * a refused connection, a DNS failure, a reset mid-body. Until
 * this translation existed, that failure escaped `fetchAndRead`
 * as the transport's raw error (a `TypeError` from fetch), and
 * every layer above the adapter that translates failures speaks
 * `PayPalError`: the direct routes (capture, record-payment, …)
 * catch domain errors + `PayPalError` and rethrow anything else,
 * and the console read routes carry no translation at all — so
 * "PayPal is unreachable" surfaced as the framework's opaque HTML
 * 500, the one sandbox failure mode with no structured shape,
 * while the webhook handler already treated any adapter throw as
 * verification-unavailable. A non-timeout transport rejection —
 * from the fetch or from the body read alike — is now translated
 * at the same choke point into a `PayPalError` with status 502
 * and name `CONNECTION_FAILED`, naming the request (method + path)
 * only: the transport error's own text is never carried, because
 * it can embed the full request URL. It is not dressed up as a
 * PayPal response — the name and message say no response was
 * received. Two failures keep their own shape ahead of it: an
 * error that is already a `PayPalError` (the response-size refusal
 * above all) passes through untouched, and a rejection caused by
 * this adapter's own timer is the timeout's 504, never a 502. This
 * supersedes the timeout chunk's original scoping, under which
 * non-timeout fetch failures were rethrown untouched (pinned by a
 * test at the time); the route-layer consequence above is why the
 * scoping changed, and the timeout suite's pin now asserts the
 * division instead — a connection failure is never a
 * `REQUEST_TIMEOUT`.
 *
 * Response size: the timeout bounds how long a call may take; this
 * bound limits how much it may return. Every response body this
 * adapter reads — the OAuth token response included — is measured
 * in UTF-8 bytes before it is parsed, and a body over
 * `SANDBOX_MAX_RESPONSE_BYTES` (4 MiB by default) is refused with a
 * `PayPalError` of status 502 and name `RESPONSE_TOO_LARGE` naming
 * the limit only (never any of the body). Until this bound existed,
 * a PayPal endpoint — or anything impersonating one — could answer
 * with an arbitrarily large body that the adapter would buffer and
 * parse in full. The bound applies to error responses too: an
 * oversized error body is refused for its size rather than mapped.
 *
 * Invalid success response: every PayPal success body is JSON, and
 * every endpoint this adapter calls answers with a JSON object.
 * Until this check existed, `readBody` mapped any unparseable body
 * to `{ message: text }` — the right leniency for an ERROR body (a
 * proxy or WAF page still reaches `toError` as its message text) —
 * but on a success status it silently turned a 200 HTML page into
 * an empty-ish resource: a dispute or invoice list came back as an
 * empty list, a fetched resource as a record with empty fields,
 * and the failure was indistinguishable from "PayPal has nothing".
 * A success body that is not valid JSON, or that parses to a
 * scalar / array / null instead of an object, is now refused at
 * the same read point with a `PayPalError` of status 502 and name
 * `INVALID_RESPONSE` — the name the adapter already used for a
 * token response with no `access_token` and a create-invoice
 * response with no id — naming the request (method + path) only,
 * never any of the body. Error responses keep their exact previous
 * mapping, JSON or not, and the empty success bodies PayPal
 * legitimately returns (send-invoice 202, remind 204) are
 * unaffected: an empty body still reads as an empty object before
 * the JSON check applies.
 *
 * Request idempotency: every mutating (POST) API call this adapter
 * makes carries a unique `PayPal-Request-Id` header
 * (`nextRequestId` below: the adapter's name, the injected clock,
 * and a per-client sequence, so ids never repeat within a client —
 * and a fixed test clock still yields distinct ids via the
 * sequence). PayPal deduplicates a retry that carries the same id
 * instead of processing it twice, so a caller retrying a call
 * whose outcome it never saw — the timeout case above is exactly
 * that shape — cannot create a second invoice, capture an order
 * twice, or pay a payout twice by re-sending. Each logical call
 * gets a NEW id: deduplication is a property of a retry of the
 * same call, never of two distinct calls that happen to carry the
 * same payload, and the suite pins that two identical payouts get
 * different ids. Reads (GET) carry no id — they mutate nothing —
 * and neither do the two POSTs that are not resource mutations:
 * the OAuth token fetch (a credential exchange, made outside
 * `request`) and webhook-signature verification (a query about a
 * delivered event, which creates and commits nothing).
 *
 * Token refresh on 401: the access token is cached until its
 * locally computed expiry, but PayPal can stop accepting a token
 * before that instant — an early expiry, a revocation, or an
 * `expires_in` that overstated the real lifetime. Until this
 * recovery existed, one such token failed EVERY call the adapter
 * made (reads, mutations, and webhook-signature verification
 * alike) until the cache happened to expire, with no way back.
 * A 401 response now invalidates the cached token (only if the
 * cache still holds the token that was used — a fresher token
 * cached by another call is never discarded), fetches a fresh
 * token, and retries the call exactly once. A 401 means PayPal
 * rejected the request before processing it, so the retry cannot
 * have duplicated a mutation; a mutating retry reuses the SAME
 * `PayPal-Request-Id` minted for the logical call, so PayPal's
 * own deduplication also treats it as the one call. A second 401
 * surfaces as the ordinary `PayPalError` (status 401, PayPal's
 * error name) — there is no retry loop — and non-401 failures
 * never trigger a refresh. The token fetch itself is outside
 * `request`, so a 401 FROM the token endpoint (bad credentials)
 * keeps its existing shape and is never retried by this path.
 * Companion hygiene: a token response whose `expires_in` is
 * non-numeric, non-positive, or non-finite falls back to the
 * default 3600-second lifetime instead of poisoning the cache
 * expiry with NaN (which silently disabled caching) or a past
 * instant.
 *
 * Token-fetch coalescing: the cache check alone does not cover
 * concurrency. The console's read routes fan out in parallel
 * (the summary route alone calls five list methods at once), and
 * on a cold or just-expired cache every one of those callers
 * found the cache empty and started its OWN token fetch before
 * any of them could populate it — N parallel calls meant N
 * credential exchanges, with the last writer winning a cache
 * they had all raced to fill. Callers that arrive while a token
 * fetch is already in flight now share that single fetch: one
 * token-endpoint call, one token for every waiter, and the
 * populated cache serves later calls as before. A failed shared
 * fetch rejects every waiter with the same error and is never
 * retained — the in-flight slot is cleared as the fetch settles,
 * so the next call retries the endpoint instead of re-throwing
 * a cached failure. The 401 refresh path goes through the same
 * `getAccessToken`, so parallel calls that share a stale token
 * also share the single refresh fetch.
 *
 * List pagination: every list endpoint this adapter calls —
 * Invoicing, Payouts, Disputes, Transaction Search — answers at
 * most one page per request, and PayPal says more pages exist by
 * carrying a HATEOAS `next` link in the response's `links`. Until
 * this following existed, each list method returned exactly its
 * first page (100 invoices / payouts / transactions, 50 disputes)
 * and silently dropped the rest — the console showed a partial
 * ledger as if it were the whole one. List calls now follow
 * `next` links until a page carries none, concatenating the pages
 * in order. The absolute href is reduced to its path + query and
 * fetched from this adapter's configured base URL — the origin in
 * the href is never trusted as the destination — and a blank or
 * unusable href ends the list like an absent link. Following is
 * bounded by `SANDBOX_MAX_LIST_PAGES` (10 pages: 1,000 invoices /
 * payouts / transactions or 500 disputes at the requested page
 * sizes): a `next` chain that has not ended by then — a cyclic or
 * runaway link — is refused with a `PayPalError` of status 502
 * and name `PAGINATION_LIMIT` naming the list endpoint only,
 * never an unbounded loop and never a silently truncated list
 * dressed as success.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Per-request timeout for every outbound PayPal call, in milliseconds. */
export const SANDBOX_REQUEST_TIMEOUT_MS = 10_000;

/** Maximum response body, in UTF-8 bytes, for every outbound PayPal call. */
export const SANDBOX_MAX_RESPONSE_BYTES = 4_194_304;

/** Maximum pages one list call will follow via `next` links before refusing. */
export const SANDBOX_MAX_LIST_PAGES = 10;

export interface SandboxConfig {
  clientId?: string;
  clientSecret?: string;
  webhookId?: string;
  baseUrl?: string;
  /** Injectable HTTP layer (tests). Defaults to global fetch. */
  fetchFn?: FetchFn;
  /** Injectable clock in epoch ms (tests / token expiry). Defaults to Date.now. */
  now?: () => number;
  /** Per-request timeout in ms. Defaults to SANDBOX_REQUEST_TIMEOUT_MS; non-positive or non-finite values fall back to the default. */
  timeoutMs?: number;
  /** Maximum response body in bytes. Defaults to SANDBOX_MAX_RESPONSE_BYTES; non-positive or non-finite values fall back to the default. */
  maxResponseBytes?: number;
}

/* ------------------------------------------------------------------ */
/* Raw-shape helpers (PayPal payloads arrive as loose JSON)            */
/* ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

function asRaw(value: unknown): Raw {
  return typeof value === "object" && value !== null ? (value as Raw) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The path + query of a list response's HATEOAS `next` link, or
 * null when the page is the last one. The href PayPal returns is
 * absolute; only its path + query are taken — the request goes to
 * this adapter's configured base URL, never to the href's origin.
 * A blank or unusable href ends the list, like an absent link.
 */
function nextPagePath(body: unknown): string | null {
  for (const link of asArray(asRaw(body).links)) {
    const r = asRaw(link);
    if (asString(r.rel) !== "next") continue;
    const href = asString(r.href).trim();
    if (!href) return null;
    try {
      const u = new URL(href);
      return `${u.pathname}${u.search}`;
    } catch {
      return href.startsWith("/") ? href : null;
    }
  }
  return null;
}

function splitName(name: string): { given_name: string; surname?: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = parts;
  return {
    given_name: first ?? name,
    ...(rest.length > 0 ? { surname: rest.join(" ") } : {}),
  };
}

function joinName(name: unknown): string {
  if (typeof name === "string") return name;
  const raw = asRaw(name);
  const full = asString(raw.full_name);
  if (full) return full;
  return [asString(raw.given_name), asString(raw.surname)].filter(Boolean).join(" ");
}

function toParty(value: unknown): Party {
  const raw = asRaw(value);
  return {
    name: joinName(raw.name),
    email_address: asString(raw.email_address),
  };
}

function toMoney(value: unknown, fallback?: Money): Money {
  const raw = asRaw(value);
  const currency = asString(raw.currency_code);
  const amount = asString(raw.value);
  if (currency && amount) {
    return { currency_code: currency as Money["currency_code"], value: amount };
  }
  return fallback ?? { currency_code: "USD", value: "0.00" };
}

function sumItems(items: Array<{ quantity: string; unit_amount: Money }>): Money {
  const currency = items[0]?.unit_amount.currency_code ?? "USD";
  const total = items.reduce(
    (acc, i) => acc + Number(i.quantity) * Number(i.unit_amount.value),
    0,
  );
  return { currency_code: currency, value: total.toFixed(2) };
}

function toInvoice(rawInput: unknown): Invoice {
  const raw = asRaw(rawInput);
  const detail = asRaw(raw.detail);
  const paymentTerm = asRaw(detail.payment_term);
  const items = asArray(raw.items).map((item) => {
    const r = asRaw(item);
    return {
      name: asString(r.name),
      quantity: asString(r.quantity, "1"),
      unit_amount: toMoney(r.unit_amount),
    };
  });
  const amount = toMoney(raw.amount, sumItems(items));
  const invoicerRaw = asRaw(raw.invoicer);
  return {
    id: asString(raw.id),
    status: asString(raw.status, "DRAFT") as Invoice["status"],
    detail: {
      invoice_number: asString(detail.invoice_number),
      note: asString(detail.note) || undefined,
      payment_term:
        Object.keys(paymentTerm).length > 0
          ? { due_date: asString(paymentTerm.due_date) || undefined }
          : undefined,
      reference: asString(detail.reference) || undefined,
    },
    invoicer:
      Object.keys(invoicerRaw).length > 0
        ? toParty(invoicerRaw)
        : { name: "PayPal sandbox seller", email_address: "" },
    primary_recipients: asArray(raw.primary_recipients).map((recipient) => ({
      billing_info: toParty(asRaw(recipient).billing_info),
    })),
    items,
    amount,
    due_amount: toMoney(raw.due_amount, amount),
    links: asArray(raw.links).map((link) => {
      const r = asRaw(link);
      return { href: asString(r.href), rel: asString(r.rel), method: asString(r.method) };
    }),
  };
}

function toOrder(rawInput: unknown): Order {
  const raw = asRaw(rawInput);
  return {
    id: asString(raw.id),
    status: asString(raw.status, "CREATED") as Order["status"],
    intent: "CAPTURE",
    purchase_units: asArray(raw.purchase_units).map((unit) => {
      const r = asRaw(unit);
      const payments = asRaw(r.payments);
      const captures = asArray(payments.captures).map((capture) => {
        const c = asRaw(capture);
        return {
          id: asString(c.id),
          status: asString(c.status),
          amount: toMoney(c.amount),
        };
      });
      return {
        reference_id: asString(r.reference_id) || undefined,
        description: asString(r.description),
        amount: toMoney(r.amount),
        ...(captures.length > 0 ? { payments: { captures } } : {}),
      };
    }),
    links: asArray(raw.links).map((link) => {
      const r = asRaw(link);
      return { href: asString(r.href), rel: asString(r.rel), method: asString(r.method) };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class SandboxPayPalClient implements PayPalClient {
  readonly mode = "sandbox" as const;
  readonly baseUrl: string;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly webhookId?: string;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  private requestSeq = 0;

  private tokenCache: { token: string; expiresAt: number } | null = null;
  /** The one in-flight token fetch concurrent callers share, if any. */
  private tokenFetchInFlight: Promise<string> | null = null;
  /** Orders v2 has no list endpoint — see the header note. */
  private readonly knownOrderIds: string[] = [];
  /** Receiver email -> recipient supplied at payout creation (names). */
  private readonly knownRecipients = new Map<string, Party>();
  private payoutSeq = 0;

  constructor(config: SandboxConfig = {}) {
    const clientId = config.clientId ?? process.env.PAYPAL_CLIENT_ID;
    const clientSecret = config.clientSecret ?? process.env.PAYPAL_CLIENT_SECRET;
    const missing: string[] = [];
    if (!clientId) missing.push("PAYPAL_CLIENT_ID");
    if (!clientSecret) missing.push("PAYPAL_CLIENT_SECRET");
    if (missing.length > 0) throw new PayPalNotConfiguredError(missing);
    if (!clientId || !clientSecret) throw new PayPalNotConfiguredError(missing);
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.webhookId = config.webhookId ?? process.env.PAYPAL_WEBHOOK_ID;
    this.baseUrl = (config.baseUrl ?? "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
    this.fetchFn = config.fetchFn ?? ((url, init) => fetch(url, init));
    this.now = config.now ?? Date.now;
    this.timeoutMs =
      config.timeoutMs !== undefined && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : SANDBOX_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes =
      config.maxResponseBytes !== undefined &&
      Number.isFinite(config.maxResponseBytes) &&
      config.maxResponseBytes > 0
        ? config.maxResponseBytes
        : SANDBOX_MAX_RESPONSE_BYTES;
  }

  /* ---------------- transport ---------------- */

  /**
   * One outbound PayPal call, bounded by the per-request timeout —
   * the timer spans the response body as well as the wait for the
   * headers: it is armed before the fetch starts and cleared only
   * after `readBody` has consumed the body, so a slow-dripping body
   * is aborted by the same bound. Rejections are translated in a
   * fixed precedence: an error that is already a `PayPalError`
   * (the response-size and invalid-success refusals `readBody`
   * raises) passes through
   * untouched; a rejection caused by our own timer — from the
   * fetch or from the body read alike — becomes the 504
   * `REQUEST_TIMEOUT`; any remaining transport rejection (no
   * response was received: refused connection, DNS failure, reset
   * mid-body) becomes the 502 `CONNECTION_FAILED`. Both name the
   * request label only (method + path — never a credential, never
   * the transport error's own text). See the header's timeout and
   * connection-failure notes.
   */
  private async fetchAndRead(
    url: string,
    init: RequestInit,
    label: string,
  ): Promise<{ res: Response; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, { ...init, signal: controller.signal });
      const body = await this.readBody(res, label);
      return { res, body };
    } catch (err) {
      if (err instanceof PayPalError) throw err;
      if (controller.signal.aborted) {
        throw new PayPalError(
          `PayPal request timed out after ${this.timeoutMs} ms: ${label}`,
          504,
          "REQUEST_TIMEOUT",
        );
      }
      throw new PayPalError(
        `PayPal request failed before a response was received: ${label}`,
        502,
        "CONNECTION_FAILED",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > this.now() + 30_000) {
      return this.tokenCache.token;
    }
    // Coalescing: a caller that arrives while a token fetch is
    // already in flight shares that fetch instead of starting a
    // second credential exchange (see the header note). Only the
    // caller that started the fetch clears the slot, and it does
    // so as the fetch settles — success or failure — so a failed
    // fetch is never retained for the next caller to re-throw.
    if (this.tokenFetchInFlight) return this.tokenFetchInFlight;
    const fetchPromise = this.fetchAccessToken();
    this.tokenFetchInFlight = fetchPromise;
    try {
      return await fetchPromise;
    } finally {
      if (this.tokenFetchInFlight === fetchPromise) this.tokenFetchInFlight = null;
    }
  }

  private async fetchAccessToken(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const { res, body } = await this.fetchAndRead(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }, "POST /v1/oauth2/token");
    if (!res.ok) throw this.toError(res.status, body, "OAuth token request failed");
    const token = asString(asRaw(body).access_token);
    if (!token) throw new PayPalError("PayPal OAuth response carried no access_token", res.status, "INVALID_RESPONSE");
    // A malformed lifetime must not poison the cache expiry: a
    // non-numeric value would make it NaN (caching silently off)
    // and a non-positive one a past instant — both fall back to
    // the default lifetime, like a missing value already did.
    const rawExpiresInSec = Number(asRaw(body).expires_in ?? 3600);
    const expiresInSec =
      Number.isFinite(rawExpiresInSec) && rawExpiresInSec > 0 ? rawExpiresInSec : 3600;
    this.tokenCache = { token, expiresAt: this.now() + expiresInSec * 1000 };
    return token;
  }

  /**
   * Drop the cached token, but only when the cache still holds
   * the exact token that was used: a concurrent call may already
   * have refreshed it, and discarding that fresher token would
   * throw away a working credential.
   */
  private invalidateCachedToken(usedToken: string): void {
    if (this.tokenCache?.token === usedToken) this.tokenCache = null;
  }

  private async readBody(res: Response, label: string): Promise<unknown> {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > this.maxResponseBytes) {
      throw new PayPalError(
        `PayPal response exceeded the ${this.maxResponseBytes}-byte limit`,
        502,
        "RESPONSE_TOO_LARGE",
      );
    }
    if (!text) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // Error responses keep the lenient mapping: a non-JSON error
      // body (a proxy/WAF page, say) still reaches `toError` as its
      // message text. A SUCCESS body that is not JSON at all is a
      // different case — see the invalid-success-response note.
      if (!res.ok) return { message: text };
      throw new PayPalError(
        `PayPal response was not valid JSON: ${label}`,
        502,
        "INVALID_RESPONSE",
      );
    }
    if (
      res.ok &&
      (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    ) {
      throw new PayPalError(
        `PayPal response was not a JSON object: ${label}`,
        502,
        "INVALID_RESPONSE",
      );
    }
    return parsed;
  }

  private toError(status: number, body: unknown, fallbackMessage: string): PayPalError {
    const raw = asRaw(body);
    const message = asString(raw.message) || asString(raw.error_description) || fallbackMessage;
    const name = asString(raw.name) || asString(raw.error) || "PAYPAL_ERROR";
    return new PayPalError(message, status, name);
  }

  /**
   * The `PayPal-Request-Id` for one logical mutating call: the
   * adapter's name, the (injectable) clock, and a per-client
   * sequence that increments on every id minted, so two ids from
   * one client never repeat — even at a fixed clock. See the
   * header's idempotency note for why each call gets a new id.
   */
  private nextRequestId(): string {
    this.requestSeq += 1;
    return `ledgerpilot-req-${this.now()}-${this.requestSeq}`;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown },
    options: { requestId?: boolean } = {},
  ): Promise<T> {
    let token = await this.getAccessToken();
    // Mutating calls carry an idempotency id by default; reads
    // never do, and a caller whose POST is not a resource
    // mutation (webhook-signature verification) opts out. The id
    // is minted once per logical call, before any attempt, so
    // the 401 retry below reuses it (see the header's token-
    // refresh note).
    const withRequestId = options.requestId ?? init.method.toUpperCase() === "POST";
    const requestId = withRequestId ? this.nextRequestId() : undefined;
    for (let attempt = 0; ; attempt += 1) {
    const { res, body } = await this.fetchAndRead(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }, `${init.method} ${path.split("?")[0]}`);
    // A 401 indicts the token, not the call: invalidate it,
    // fetch a fresh one, and retry exactly once. A second 401
    // falls through to the ordinary error mapping below.
    if (res.status === 401 && attempt === 0) {
      this.invalidateCachedToken(token);
      token = await this.getAccessToken();
      continue;
    }
    if (!res.ok) throw this.toError(res.status, body, `PayPal ${init.method} ${path} failed`);
    return body as T;
    }
  }

  /**
   * Fetch every page of a list endpoint, following the responses'
   * HATEOAS `next` links (see the header's pagination note), and
   * return the concatenated raw items in page order. A chain that
   * has not ended after `SANDBOX_MAX_LIST_PAGES` pages is refused
   * loudly instead of looping forever or truncating silently.
   */
  private async listAllPages(
    firstPath: string,
    extractItems: (body: unknown) => unknown[],
  ): Promise<unknown[]> {
    const collected: unknown[] = [];
    let path: string | null = firstPath;
    for (let fetched = 0; path !== null; fetched += 1) {
      if (fetched >= SANDBOX_MAX_LIST_PAGES) {
        throw new PayPalError(
          `PayPal list exceeded the ${SANDBOX_MAX_LIST_PAGES}-page limit: GET ${firstPath.split("?")[0]}`,
          502,
          "PAGINATION_LIMIT",
        );
      }
      const body = await this.request<unknown>(path, { method: "GET" });
      collected.push(...extractItems(body));
      path = nextPagePath(body);
    }
    return collected;
  }

  /* ---------------- Invoicing v2 ---------------- */

  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    const body = {
      detail: {
        currency_code: input.items[0]?.unit_amount.currency_code ?? "USD",
        note: input.note,
        reference: input.reference,
        payment_term: input.dueDate
          ? { term_type: "DUE_ON_DATE_SPECIFIED", due_date: input.dueDate }
          : undefined,
      },
      primary_recipients: [
        {
          billing_info: {
            name: splitName(input.recipient.name),
            email_address: input.recipient.email_address,
          },
        },
      ],
      items: input.items,
      configuration: { partial_payment: { allow_partial_payment: true } },
    };
    const created = await this.request<unknown>("/v2/invoicing/invoices", { method: "POST", body });
    const raw = asRaw(created);
    let id = asString(raw.id);
    if (!id) {
      const self = asArray(raw.links)
        .map((link) => asRaw(link))
        .find((link) => asString(link.rel) === "self");
      const href = asString(self?.href);
      id = href.split("/").filter(Boolean).pop() ?? "";
    }
    if (!id) {
      throw new PayPalError("PayPal create-invoice response carried no invoice id or self link", 502, "INVALID_RESPONSE");
    }
    return this.getInvoice(id);
  }

  async sendInvoice(invoiceId: string): Promise<Invoice> {
    await this.request<unknown>(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
      method: "POST",
      body: { send_to_invoicer: true, send_to_recipient: true },
    });
    return this.getInvoice(invoiceId);
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    const raw = await this.request<unknown>(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`, {
      method: "GET",
    });
    return toInvoice(raw);
  }

  async listInvoices(): Promise<Invoice[]> {
    const items = await this.listAllPages("/v2/invoicing/invoices?page_size=100", (body) => {
      const container = asRaw(body);
      return asArray(container.items ?? container.invoices);
    });
    return items.map((item) => toInvoice(item));
  }

  async recordInvoicePayment(
    invoiceId: string,
    amount: { value: string; currency_code: string },
  ): Promise<Invoice> {
    await this.request<unknown>(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/payments`, {
      method: "POST",
      body: { method: "OTHER", amount },
    });
    return this.getInvoice(invoiceId);
  }

  async sendInvoiceReminder(invoiceId: string, input: SendInvoiceReminderInput = {}): Promise<Invoice> {
    // The real endpoint answers 204 No Content; the invoice is re-fetched
    // afterwards, exactly like sendInvoice handles its empty 202.
    await this.request<unknown>(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/remind`, {
      method: "POST",
      body: {
        subject: input.subject ?? "Reminder: your invoice is due",
        note: input.note,
        send_to_invoicer: false,
        send_to_recipient: true,
      },
    });
    return this.getInvoice(invoiceId);
  }

  /* ---------------- Orders v2 ---------------- */

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const raw = await this.request<unknown>("/v2/checkout/orders", {
      method: "POST",
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.reference_id,
            description: input.description,
            amount: input.amount,
          },
        ],
      },
    });
    const order = toOrder(raw);
    if (order.id && !this.knownOrderIds.includes(order.id)) this.knownOrderIds.push(order.id);
    return order;
  }

  async captureOrder(orderId: string): Promise<Order> {
    const raw = await this.request<unknown>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      body: {},
    });
    return toOrder(raw);
  }

  async listOrders(): Promise<Order[]> {
    const orders: Order[] = [];
    for (const id of this.knownOrderIds) {
      const raw = await this.request<unknown>(`/v2/checkout/orders/${encodeURIComponent(id)}`, {
        method: "GET",
      });
      orders.push(toOrder(raw));
    }
    return orders;
  }

  /* ---------------- Payouts ---------------- */

  private toPayoutBatch(rawInput: unknown, fallbackItems?: PayoutBatch["items"]): PayoutBatch {
    const raw = asRaw(rawInput);
    const header = asRaw(raw.batch_header ?? raw);
    const senderHeader = asRaw(header.sender_batch_header);
    const rawItems = asArray(raw.items);
    const items: PayoutBatch["items"] =
      rawItems.length > 0
        ? rawItems.map((item) => {
            const r = asRaw(item);
            const payoutItem = asRaw(r.payout_item ?? r);
            const receiver = asString(payoutItem.receiver);
            const known = this.knownRecipients.get(receiver);
            return {
              payout_item_id: asString(r.payout_item_id),
              transaction_status: asString(r.transaction_status, "PENDING") as PayoutBatch["items"][number]["transaction_status"],
              payout_item: {
                recipient: known ?? { name: receiver, email_address: receiver },
                amount: toMoney(payoutItem.amount),
                note: asString(payoutItem.note) || undefined,
                sender_item_id: asString(payoutItem.sender_item_id) || undefined,
                receiver,
              },
            };
          })
        : (fallbackItems ?? []);
    return {
      batch_header: {
        payout_batch_id: asString(header.payout_batch_id),
        batch_status: asString(header.batch_status, "PENDING") as PayoutBatch["batch_header"]["batch_status"],
        time_created: asString(header.time_created),
        sender_batch_header: {
          sender_batch_id: asString(senderHeader.sender_batch_id),
          email_subject: asString(senderHeader.email_subject) || undefined,
          email_message: asString(senderHeader.email_message) || undefined,
        },
      },
      items,
      links: asArray(raw.links).map((link) => {
        const r = asRaw(link);
        return { href: asString(r.href), rel: asString(r.rel), method: asString(r.method) };
      }),
    };
  }

  async createPayout(input: CreatePayoutInput): Promise<PayoutBatch> {
    for (const item of input.items) {
      this.knownRecipients.set(item.recipient.email_address, item.recipient);
    }
    this.payoutSeq += 1;
    const senderBatchId = `LEDGERPILOT-${this.now()}-${this.payoutSeq}`;
    const fallbackItems: PayoutBatch["items"] = input.items.map((item, idx) => ({
      payout_item_id: "",
      transaction_status: "PENDING",
      payout_item: { ...item, receiver: item.recipient.email_address, sender_item_id: item.sender_item_id ?? `item-${idx + 1}` },
    }));
    const raw = await this.request<unknown>("/v1/payments/payouts", {
      method: "POST",
      body: {
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          email_subject: input.emailSubject ?? "You have a payout from LedgerPilot",
          email_message: input.emailMessage,
        },
        items: input.items.map((item, idx) => ({
          recipient_type: "EMAIL",
          receiver: item.recipient.email_address,
          amount: item.amount,
          note: item.note,
          sender_item_id: item.sender_item_id ?? `item-${idx + 1}`,
        })),
      },
    });
    return this.toPayoutBatch(raw, fallbackItems);
  }

  async listPayouts(): Promise<PayoutBatch[]> {
    const items = await this.listAllPages("/v1/payments/payouts?page_size=100", (body) =>
      asArray(asRaw(body).items),
    );
    return items.map((item) => this.toPayoutBatch(item));
  }

  /* ---------------- Read-only surfaces ---------------- */

  async listDisputes(): Promise<Dispute[]> {
    const rawItems = await this.listAllPages("/v1/customer/disputes?page_size=50", (body) =>
      asArray(asRaw(body).items),
    );
    return rawItems.map((item) => {
      const r = asRaw(item);
      const status = asString(r.status, "OPEN");
      return {
        dispute_id: asString(r.dispute_id),
        create_time: asString(r.create_time),
        update_time: asString(r.update_time),
        disputed_transactions: asArray(r.disputed_transactions).map((txn) => {
          const t = asRaw(txn);
          return {
            seller_transaction_id: asString(t.seller_transaction_id),
            buyer: toParty(t.buyer),
          };
        }),
        amount: toMoney(r.amount),
        reason: asString(r.reason),
        status: (["OPEN", "WAITING_FOR_BUYER_RESPONSE", "WAITING_FOR_SELLER_RESPONSE", "RESOLVED"].includes(status)
          ? status
          : "OPEN") as Dispute["status"],
        dispute_life_cycle_stage: asString(r.dispute_life_cycle_stage),
        ...(typeof r.response_due_date === "string" && r.response_due_date
          ? { response_due_date: r.response_due_date }
          : {}),
      };
    });
  }

  async listTransactions(): Promise<Transaction[]> {
    const end = new Date(this.now());
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const query =
      `start_date=${encodeURIComponent(start.toISOString())}` +
      `&end_date=${encodeURIComponent(end.toISOString())}&fields=all&page_size=100`;
    const entries = await this.listAllPages(`/v1/reporting/transactions?${query}`, (body) =>
      asArray(asRaw(body).transaction_details),
    );
    return entries.map((entry) => {
      const e = asRaw(entry);
      // Real shape nests the fields under transaction_info; tolerate a flat shape too.
      const info = asRaw(e.transaction_info ?? e);
      const payer = asRaw(e.payer_info);
      const payerRaw = asRaw(payer.payer_name ?? payer);
      return {
        transaction_id: asString(info.transaction_id),
        transaction_event_code: asString(info.transaction_event_code),
        transaction_initiation_date: asString(info.transaction_initiation_date),
        transaction_amount: toMoney(info.transaction_amount),
        transaction_status: (asString(info.transaction_status, "S") || "S") as Transaction["transaction_status"],
        transaction_subject: asString(info.transaction_subject) || undefined,
        payer_info: {
          email_address: asString(payer.email_address) || asString(payerRaw.email_address) || undefined,
          name: joinName(payerRaw) || asString(payer.account_reference) || undefined,
        },
      };
    });
  }

  /* ---------------- Webhooks ---------------- */

  async verifyWebhookSignature(headers: Record<string, string>, event: WebhookEvent): Promise<boolean> {
    if (!this.webhookId) return false;
    const transmissionId = headers["paypal-transmission-id"];
    const transmissionSig = headers["paypal-transmission-sig"];
    const transmissionTime = headers["paypal-transmission-time"];
    const certUrl = headers["paypal-cert-url"];
    const authAlgo = headers["paypal-auth-algo"];
    if (!transmissionId || !transmissionSig || !transmissionTime || !certUrl || !authAlgo) return false;
    const raw = await this.request<unknown>("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: this.webhookId,
        webhook_event: event,
      },
      // Verification is a query about a delivered event — it
      // creates and commits nothing, so it carries no
      // idempotency id (see the header note).
    }, { requestId: false });
    return asString(asRaw(raw).verification_status) === "SUCCESS";
  }
}
