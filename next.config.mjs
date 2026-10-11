/**
 * Next.js configuration.
 *
 * Security headers (see SECURITY.md, "HTTP security headers"): every
 * response — pages and API routes alike — carries the baseline set
 * below. The app is same-origin by construction: all assets are
 * bundled, all browser calls go to `/api/*` on the same origin, and
 * PayPal / LLM traffic is server-side only, so the Content Security
 * Policy needs no external origin and no wildcard anywhere.
 *
 * Two directives are deliberately scoped:
 * - `'unsafe-inline'` for scripts and styles: the App Router emits
 *   inline bootstrap scripts and the console uses inline style
 *   attributes (AG Grid included). Eval execution is never allowed
 *   in production; it is added only in development, where the dev
 *   toolchain (HMR / React dev builds) requires it, together with
 *   the `ws:` / `wss:` HMR socket in `connect-src`.
 * - HSTS carries no `preload` token: preloading is effectively
 *   irreversible and is a decision for a permanent production host,
 *   not for a hackathon demo deployment.
 */

/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV === "development";

const scriptSrc = isDev
  ? "'self' 'unsafe-inline' 'unsafe-eval'"
  : "'self' 'unsafe-inline'";
const connectSrc = isDev ? "'self' ws: wss:" : "'self'";

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src ${connectSrc}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig = {
  // Do not advertise the framework in a response header.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
