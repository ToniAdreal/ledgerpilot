/**
 * Checkout link / buyer view — the buyer-facing half of the Orders v2
 * leg (CONCEPT.md §3.1 `/checkout`: "create an Orders v2 checkout
 * link, show buyer view"; §3.2 step 5: "buyer approves in sandbox
 * checkout → capture").
 *
 * Until this module existed, both adapters faithfully carried the
 * order's HATEOAS links (mock: an `approve` link on every created
 * order; sandbox: PayPal's real links, mapped through verbatim), but
 * no layer ever read them: the seller could create an order and
 * capture it, yet could never see — let alone share — the checkout
 * link the buyer is supposed to open. The sell loop had a buyer step
 * with no buyer surface.
 *
 * This module is the pure resolution half:
 *
 *  - `findCheckoutLink` picks the buyer-approval link: rel `approve`
 *    (the classic Orders v2 shape) first, then `payer-action` (the
 *    newer PayPal shape), never `self`. An empty/blank href is not a
 *    link.
 *  - `resolveCheckoutView` turns an order into exactly one honest
 *    buyer-view state. A captured order is never offered a pay link
 *    again (it is paid), a VOIDED order never is either, and an
 *    order whose adapter returned no approval link is reported as
 *    `unavailable` — a link is never invented.
 *  - Mock links are flagged, never disguised: an href starting with
 *    `mock://` is the mock adapter's stand-in for PayPal's hosted
 *    checkout, and the view labels it as such, so a demo screenshot
 *    can never present a mock URL as a real PayPal page.
 */

import type { Order } from "../types";

export interface CheckoutLink {
  href: string;
  /** The HATEOAS rel the link was found under: `approve` | `payer-action`. */
  rel: string;
  /** True for the mock adapter's `mock://` stand-in links. */
  isMock: boolean;
}

export type CheckoutViewKind = "payable" | "captured" | "voided" | "unavailable";

export interface CheckoutView {
  kind: CheckoutViewKind;
  /** The buyer checkout URL — present only when `kind` is `payable`. */
  href?: string;
  /** True when the payable href is a mock stand-in, not a PayPal URL. */
  isMock: boolean;
  /** Short cell label for the console's Buyer view column. */
  label: string;
  /** One-sentence explanation of the state, for tooltips/detail copy. */
  guidance: string;
}

/** Rel values that take a buyer to PayPal's approval/checkout page, in preference order. */
const BUYER_LINK_RELS: readonly string[] = ["approve", "payer-action"];

export function findCheckoutLink(order: Order): CheckoutLink | null {
  for (const rel of BUYER_LINK_RELS) {
    const link = order.links.find((l) => l.rel === rel && l.href.trim() !== "");
    if (link) {
      return { href: link.href, rel: link.rel, isMock: link.href.startsWith("mock://") };
    }
  }
  return null;
}

export function resolveCheckoutView(order: Order): CheckoutView {
  const captured =
    order.status === "COMPLETED" ||
    (order.purchase_units[0]?.payments?.captures?.length ?? 0) > 0;
  if (captured) {
    return {
      kind: "captured",
      isMock: false,
      label: "Paid via checkout",
      guidance: "The buyer completed checkout and the order was captured — there is no checkout link to share anymore.",
    };
  }
  if (order.status === "VOIDED") {
    return {
      kind: "voided",
      isMock: false,
      label: "—",
      guidance: "A voided order can never be paid or captured.",
    };
  }
  const link = findCheckoutLink(order);
  if (!link) {
    return {
      kind: "unavailable",
      isMock: false,
      label: "No checkout link",
      guidance:
        "PayPal returned no buyer approval link for this order, so there is no checkout page to share. The order can still be captured only if the buyer approved it through another channel.",
    };
  }
  return {
    kind: "payable",
    href: link.href,
    isMock: link.isMock,
    label: link.isMock ? "Open mock checkout" : "Open checkout",
    guidance: link.isMock
      ? "Mock-mode stand-in for PayPal's hosted checkout page — in sandbox mode this is the real PayPal approval URL the buyer opens. Capturing stands in for the buyer completing this page in mock mode."
      : "The buyer opens this PayPal-hosted checkout link to approve the order; capture succeeds only after that approval.",
  };
}
