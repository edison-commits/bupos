import type { MetadataRoute } from "next";

const baseUrl = "https://basicuniformpos.com";

const publicRoutes: Array<{ path: string; priority: number }> = [
  { path: "/", priority: 1 },
  { path: "/login", priority: 0.4 },
  { path: "/signup", priority: 0.5 },
  { path: "/customer-signup", priority: 0.5 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return publicRoutes.map(({ path, priority }) => ({
    url: `${baseUrl}${path}`,
    lastModified,
    changeFrequency: "weekly",
    priority,
  }));
}
