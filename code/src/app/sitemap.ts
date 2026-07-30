import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://basicuniformpos.com";
  return ["/", "/demo", "/demo/features", "/signup", "/pricing", "/support", "/privacy", "/terms"].map((path) => ({ url: `${base}${path}`, lastModified: new Date() }));
}
