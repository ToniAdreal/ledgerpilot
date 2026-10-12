"use client";

/**
 * Standalone /command surface: renders the console's own
 * Agent Command bar (src/app/command-bar.tsx) — the one
 * brief → plan review → approve / reject → execute component —
 * so there is no second command implementation to drift.
 *
 * The console passes its refresh as `onSettled` so a settled
 * decision repaints the KPI strip and grids; this page has no
 * grids of its own, so the callback is a deliberate no-op:
 * CommandBar itself reloads the pending-decision queue and
 * re-renders the reviewed plan after every decision, and the
 * server-side approval gate remains the enforcement point
 * either way.
 */

import { useCallback } from "react";
import CommandBar from "../command-bar";

export default function CommandClient() {
  const onSettled = useCallback(() => {
    /* no console surfaces on this page to refresh — see header */
  }, []);

  return <CommandBar onSettled={onSettled} />;
}
