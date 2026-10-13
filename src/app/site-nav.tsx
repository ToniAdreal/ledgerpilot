"use client";

// Primary site navigation, rendered by the root layout on every page
// (the global-error fallback replaces the layout itself, so it is the
// one surface without it — the same documented limit as its styling).
// The link list itself lives in src/lib/nav/site-nav.ts, the single
// source of truth the tests pin against the pages on disk; this
// component only renders it and marks the current page's link with
// aria-current="page" (resolved by the same module's pure helper, so
// /invoices/[id] keeps the Invoices link current).

import { usePathname } from "next/navigation";
import { SITE_NAV_LINKS, isSiteNavLinkActive } from "../lib/nav/site-nav";

export default function SiteNav() {
  const pathname = usePathname() ?? "/";
  return (
    <header className="site-header">
      <nav className="site-nav" aria-label="Primary">
        <a className="site-nav-brand" href="/">
          LedgerPilot
        </a>
        <ul className="site-nav-list">
          {SITE_NAV_LINKS.map((link) => {
            const active = isSiteNavLinkActive(pathname, link.href);
            return (
              <li key={link.href}>
                <a
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={active ? "site-nav-link site-nav-link-active" : "site-nav-link"}
                >
                  {link.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
