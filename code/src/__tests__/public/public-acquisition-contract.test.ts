import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("public acquisition and trust contract", () => {
  it("offers a demo-first path from the public sign-in page", () => {
    const home = read("src/app/page.tsx");

    expect(home).toContain('href="/demo/features"');
    expect(home).toContain("See how BUPOS works");
    expect(home).toContain("Explore with sample store data");
    expect(home).toContain('href="/privacy"');
    expect(home).toContain('href="/terms"');
    expect(home).toContain('href="/support"');
  });

  it("keeps the product showcase demo-first and removes an unverified mailbox CTA", () => {
    const showcase = read("src/app/demo/features/page.tsx");

    expect(showcase).toContain('href="/demo"');
    expect(showcase).toContain('href="/support"');
    expect(showcase).toContain('href="/privacy"');
    expect(showcase).toContain('href="/terms"');
    expect(showcase).not.toContain("mailto:");
    expect(showcase).toContain("sample store data");
    expect(showcase).toContain("No real payment is processed");
  });

  it("publishes clear privacy, terms, and support boundaries", () => {
    const privacy = read("src/app/privacy/page.tsx");
    const terms = read("src/app/terms/page.tsx");
    const support = read("src/app/support/page.tsx");

    expect(privacy).toContain("Information BUPOS handles");
    expect(privacy).toContain("The public demo uses sample store data");
    expect(privacy).toContain("Do not enter real customer or payment information");
    expect(terms).toContain("Evaluation and demo use");
    expect(terms).toContain("does not process a real payment");
    expect(terms).toContain("No uptime or response-time commitment");
    expect(support).toContain("Existing store operators");
    expect(support).toContain("Generate support packet");
    expect(support).toContain("No public response-time promise");
  });

  it("indexes intentional acquisition and trust routes only", () => {
    const sitemap = read("src/app/sitemap.ts");

    for (const route of ["/demo/features", "/privacy", "/terms", "/support"]) {
      expect(sitemap).toContain(`path: "${route}"`);
    }
    expect(sitemap).not.toContain('path: "/demo"');
  });
});
