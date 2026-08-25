import type { Metadata } from "next";
import { PublicInfoPage } from "@/components/public/public-info-page";

export const metadata: Metadata = {
  title: "Terms",
  description: "Evaluation and account-use terms for BasicUniformPOS.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <PublicInfoPage
      eyebrow="Trust"
      title="Terms for evaluating BUPOS"
      intro="These plain-language terms describe the public evaluation surface. Store-specific commercial, support, and data terms must be reviewed before live use."
    >
      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">Evaluation and demo use</h2>
        <p className="mt-3">The public demo is provided to explore product workflows with sample store data. It does not process a real payment, update production store data, or prove that every workflow is configured for a particular retailer.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">Account responsibility</h2>
        <p className="mt-3">Store users are responsible for protecting their credentials, assigning appropriate roles and locations, and reviewing operational settings before use. Do not share access codes or enter live customer, employee, payment, or store records into an evaluation surface unless that use has been expressly agreed.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">Availability and support</h2>
        <p className="mt-3">The public demo may change or be unavailable while the product evolves. No uptime or response-time commitment is made on the public site. Any service level, support model, pilot scope, pricing, or production availability must be confirmed separately before a store relies on BUPOS.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">Acceptable use</h2>
        <p className="mt-3">Do not attempt to access another store, bypass authentication or permissions, disrupt the service, introduce malicious code, or use the demo to collect real personal or payment information.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">Before production use</h2>
        <p className="mt-3">A retailer should review fit, setup, data handling, integrations, payment responsibilities, recovery procedures, and staff training before production use. The demo is an evaluation aid, not a guarantee of fitness for a specific store.</p>
      </section>
    </PublicInfoPage>
  );
}
