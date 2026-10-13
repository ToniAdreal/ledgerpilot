// Site navigation — the single source of truth for the primary nav
// rendered by the root layout on every page.
//
// Before this module existed, the surfaces were cross-linked only by
// prose: the console home carried a paragraph of "likewise" links and
// each standalone page carried a "← Operations Console" back-link, so
// moving from one surface to another (Invoices → Payouts, say) always
// meant going home first. The nav fixes that in one place: every
// addressable page is reachable from every other page.
//
// Rules the tests pin:
// - Every href is a same-origin path that exists as a page on disk
//   (the suite walks src/app for page.tsx files and requires exact
//   agreement with the static top-level routes — a new page that is
//   not added here fails, and a link to a removed page fails).
// - Dynamic segments (e.g. /invoices/[id]) are detail routes, not
//   primary-nav destinations, and are deliberately absent.
// - No external URL is ever listed: no public host exists before the
//   hosted deployment, and none is invented here.

export interface SiteNavLink {
  href: string;
  label: string;
}

export const SITE_NAV_LINKS: readonly SiteNavLink[] = [
  { href: "/", label: "Console" },
  { href: "/command", label: "Command" },
  { href: "/invoices", label: "Invoices" },
  { href: "/checkout", label: "Checkout" },
  { href: "/payouts", label: "Payouts" },
  { href: "/disputes", label: "Disputes" },
  { href: "/transactions", label: "Reconciliation" },
  { href: "/activity", label: "Activity" },
  { href: "/judge", label: "Judge Mode" },
  { href: "/api-docs", label: "API docs" },
];

/**
 * Whether a nav link names the page currently being viewed. The root
 * (console) link matches only the exact root path — every other page
 * also starts with "/", so a prefix rule there would mark Console
 * active everywhere. Other links match their own path and anything
 * under it (the invoice detail page lives under /invoices, so the
 * Invoices link stays current there).
 */
export function isSiteNavLinkActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
