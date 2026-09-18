import type { Metadata } from "next";
import Link from "next/link";
import { PublicInfoPage } from "@/components/public/public-info-page";

export const metadata: Metadata = {
  title: "Support",
  description: "Safe evaluation and operator support paths for BasicUniformPOS.",
  alternates: { canonical: "/support" },
};

export default function SupportPage() {
  return (
    <PublicInfoPage
      eyebrow="Support"
      title="Start with the right support path"
      intro="BUPOS keeps public evaluation separate from authenticated store diagnostics so sample questions and live store evidence do not get mixed together."
    >
      <section className="grid gap-5 md:grid-cols-2">
        <div className="rounded-2xl border border-[#15201f]/15 bg-white p-6">
          <h2 className="text-2xl font-semibold text-[#15201f]">Evaluating BUPOS</h2>
          <p className="mt-3">Review the product screens, then open the interactive demo with sample store data. No account is required and no real payment is processed.</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/demo/features" className="rounded-full border border-[#15201f]/20 px-4 py-2 font-semibold text-[#15201f] hover:border-[#0b8279] hover:text-[#0b8279]">Review the product</Link>
            <Link href="/demo" className="rounded-full bg-[#0b8279] px-4 py-2 font-semibold text-white hover:bg-[#086b64]">Open the demo</Link>
          </div>
        </div>

        <div className="rounded-2xl border border-[#15201f]/15 bg-white p-6">
          <h2 className="text-2xl font-semibold text-[#15201f]">Existing store operators</h2>
          <p className="mt-3">Sign in, open <strong>Help</strong> in the admin navigation, run the read-only checks, and choose <strong>Generate support packet</strong>. The packet is designed to carry operational evidence without running a repair.</p>
          <Link href="/login" className="mt-6 inline-flex rounded-full bg-[#15201f] px-4 py-2 font-semibold text-white hover:bg-[#0b8279]">Sign in to BUPOS</Link>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">What to include</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>What you were trying to do and the screen where it happened.</li>
          <li>When it happened and whether retrying changed the result.</li>
          <li>The request ID or generated support packet when available.</li>
        </ul>
        <p className="mt-3">Do not place passwords, access codes, full payment details, or unnecessary customer information in support notes.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-[#15201f]">No public response-time promise</h2>
        <p className="mt-3">There is no incident-status guarantee or emergency support commitment on this site. Support scope and escalation should be agreed before production use. If register operations are at risk, pause risky actions and preserve the on-screen request ID or support packet for review.</p>
      </section>
    </PublicInfoPage>
  );
}
