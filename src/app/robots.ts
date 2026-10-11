import type { MetadataRoute } from "next";

// The hosted demo is public for judges, so its pages may be indexed;
// the API surface is machine interface, not content, and is kept out
// of search indexes. Judge Mode's seed/pay/reset controls are demo
// actions on those pages, not separate crawlable routes.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
  };
}
