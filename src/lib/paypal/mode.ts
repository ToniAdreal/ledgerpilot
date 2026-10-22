/**
 * PAYPAL_MODE normalisation — the one place the mode value is read.
 *
 * The effective mode is decided by trimming surrounding whitespace and
 * lower-casing the configured value: only "sandbox" selects the sandbox
 * adapter; everything else (unset, blank, "mock", or any unknown value)
 * is mock. Until this normaliser existed, the client factory lower-cased
 * but did NOT trim (`(env.PAYPAL_MODE ?? "mock").toLowerCase()`), while
 * the health report trimmed first — so a padded value such as
 * " sandbox " (a common copy-paste / env-file accident) was reported by
 * `GET /api/health` as sandbox while the factory silently ran the mock
 * adapter: the readiness surface and the runtime disagreed about which
 * adapter was live. Both surfaces now build the effective mode through
 * this function (the health report imports it from this leaf module,
 * which loads no adapter, so it still constructs nothing).
 */
export type PayPalMode = "mock" | "sandbox";

export function normalizePayPalMode(value: string | undefined | null): PayPalMode {
  return (value ?? "").trim().toLowerCase() === "sandbox" ? "sandbox" : "mock";
}
