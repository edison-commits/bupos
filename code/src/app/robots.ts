import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin/", "/api/", "/dashboard", "/pos", "/register"] }],
    sitemap: "https://basicuniformpos.com/sitemap.xml",
  };
}
