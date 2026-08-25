import type { Metadata } from "next";
import { PublicInfoPage } from "@/components/public/public-info-page";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How BasicUniformPOS handles information in the public demo and store accounts.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <PublicInfoPage
      eyebrow="Trust"
      title="Privacy at BUPOS"
      intro="This page explains the information BUPOS is designed to handle and the boundary between the public demo and a store account."
    >
      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">The public demo</h2>
        <p className="mt-3">The public demo uses sample store data and does not require an account. Actions stay inside the simulated demo experience; they do not update a live store or process a real payment.</p>
        <p className="mt-3 font-semibold text-[#15201f]">Do not enter real customer or payment information into the public demo.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">Information BUPOS handles</h2>
        <p className="mt-3">When a store account is used, BUPOS can hold account and staff details, store and location settings, product and inventory records, supplier and purchasing records, customer records, transaction and tender records, and operational audit history.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">How store information is used</h2>
        <p className="mt-3">Store information supports the register, inventory, purchasing, customer, reporting, employee-permission, and audit workflows selected by that store. BUPOS does not use the public demo as proof of how a particular store configures or governs its own data.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">Access, retention, and deletion</h2>
        <p className="mt-3">Access to store data is controlled through store accounts, roles, and assigned locations. Retention and deletion needs should be agreed during evaluation before live store data is imported or entered. Existing operators should use the authenticated Help area to generate a support packet without placing customer records in a public request.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">Service boundaries</h2>
        <p className="mt-3">BUPOS is a web application and depends on hosting, database, and network services to operate. A store may also choose integrations or payment workflows with their own terms and privacy practices. Those external services are not covered by this page.</p>
      </section>
    </PublicInfoPage>
  );
}
