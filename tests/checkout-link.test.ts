import { describe, expect, it } from "vitest";
import { findCheckoutLink, resolveCheckoutView } from "../src/lib/checkout/checkout-link";
import { buildOrderRows } from "../src/lib/console/read-models";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import type { Order } from "../src/lib/types";

function orderWith(overrides: Partial<Order>): Order {
  return {
    id: "ORDER-TEST",
    status: "CREATED",
    intent: "CAPTURE",
    purchase_units: [
      { description: "Logo pack", amount: { currency_code: "USD", value: "75.00" } },
    ],
    links: [
      { href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TEST", rel: "approve", method: "GET" },
      { href: "https://api.sandbox.paypal.com/v2/checkout/orders/ORDER-TEST", rel: "self", method: "GET" },
    ],
    ...overrides,
  };
}

describe("findCheckoutLink", () => {
  it("finds the approve link and never the self link", () => {
    const link = findCheckoutLink(orderWith({}));
    expect(link).toEqual({
      href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TEST",
      rel: "approve",
      isMock: false,
    });
  });

  it("falls back to payer-action when no approve link exists", () => {
    const link = findCheckoutLink(
      orderWith({
        links: [
          { href: "https://www.sandbox.paypal.com/checkoutnow?token=X", rel: "payer-action", method: "GET" },
        ],
      }),
    );
    expect(link?.rel).toBe("payer-action");
  });

  it("prefers approve over payer-action, flags mock hrefs, and ignores blank hrefs", () => {
    const mockOrder = orderWith({
      links: [
        { href: "mock://paypal/checkoutnow?token=ORDER-TEST", rel: "payer-action", method: "GET" },
        { href: "mock://paypal/checkoutnow?token=ORDER-TEST", rel: "approve", method: "GET" },
      ],
    });
    const link = findCheckoutLink(mockOrder);
    expect(link?.rel).toBe("approve");
    expect(link?.isMock).toBe(true);
    expect(
      findCheckoutLink(orderWith({ links: [{ href: "  ", rel: "approve", method: "GET" }] })),
    ).toBeNull();
    expect(findCheckoutLink(orderWith({ links: [] }))).toBeNull();
  });
});

describe("resolveCheckoutView", () => {
  it("a CREATED order with an approval link is payable with that exact href", () => {
    const view = resolveCheckoutView(orderWith({}));
    expect(view.kind).toBe("payable");
    expect(view.href).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TEST");
    expect(view.isMock).toBe(false);
    expect(view.label).toBe("Open checkout");
  });

  it("a mock order's view is payable but labeled as a mock checkout", () => {
    const view = resolveCheckoutView(
      orderWith({ links: [{ href: "mock://paypal/checkoutnow?token=ORDER-TEST", rel: "approve", method: "GET" }] }),
    );
    expect(view.kind).toBe("payable");
    expect(view.isMock).toBe(true);
    expect(view.label).toBe("Open mock checkout");
    expect(view.guidance).toMatch(/Mock-mode stand-in/);
  });

  it("a captured order is never offered a pay link again", () => {
    const view = resolveCheckoutView(orderWith({ status: "COMPLETED" }));
    expect(view.kind).toBe("captured");
    expect(view.href).toBeUndefined();
    expect(view.label).toBe("Paid via checkout");
  });

  it("a VOIDED order is voided, and a link-less open order is honestly unavailable", () => {
    expect(resolveCheckoutView(orderWith({ status: "VOIDED" })).kind).toBe("voided");
    const missing = resolveCheckoutView(orderWith({ links: [] }));
    expect(missing.kind).toBe("unavailable");
    expect(missing.href).toBeUndefined();
    expect(missing.label).toBe("No checkout link");
  });
});

describe("order rows carry the buyer view (mock loop)", () => {
  it("a created order is payable via its mock link; after capture the row is captured with no URL", async () => {
    const client = new MockPayPalClient({ sampleDispute: false });
    const order = await client.createOrder({
      description: "Logo pack download",
      amount: { currency_code: "USD", value: "75.00" },
    });

    const [createdRow] = buildOrderRows(await client.listOrders());
    expect(createdRow!.id).toBe(order.id);
    expect(createdRow!.checkoutState).toBe("payable");
    expect(createdRow!.checkoutUrl).toBe(`mock://paypal/checkoutnow?token=${order.id}`);
    expect(createdRow!.checkoutIsMock).toBe(true);
    expect(createdRow!.checkoutLabel).toBe("Open mock checkout");

    await client.captureOrder(order.id);
    const [capturedRow] = buildOrderRows(await client.listOrders());
    expect(capturedRow!.checkoutState).toBe("captured");
    expect(capturedRow!.checkoutUrl).toBe("");
    expect(capturedRow!.checkoutLabel).toBe("Paid via checkout");
  });

  it("an order with no purchase units still resolves a buyer view from its links", () => {
    const [row] = buildOrderRows([
      {
        id: "ORDER-EMPTY",
        status: "CREATED",
        intent: "CAPTURE",
        purchase_units: [],
        links: [{ href: "mock://paypal/checkoutnow?token=ORDER-EMPTY", rel: "approve", method: "GET" }],
      },
    ]);
    expect(row!.checkoutState).toBe("payable");
    expect(row!.checkoutUrl).toContain("ORDER-EMPTY");
  });
});
