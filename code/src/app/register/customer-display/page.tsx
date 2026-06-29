import type { Metadata } from "next";
import { CustomerDisplayClient } from "./customer-display-client";

export const metadata: Metadata = { title: "Customer Display | BasicUniformPOS" };

export const dynamic = "force-dynamic";

export default async function CustomerDisplayPage() {
  // Don't import env at module level — it throws if BUPOS_ORG_ID is missing
  // during static generation. Use dynamic import instead.
  const orgId = process.env.BUPOS_ORG_ID;

  if (!orgId) {
    return <CustomerDisplayClient storeName="" locationName="" />;
  }

  const { readCustomerDisplayBranding } = await import("@/lib/persistence/store");
  const branding = await readCustomerDisplayBranding(orgId);
  const customerDisplayBranding = {
    displayName: branding.displayName,
    welcomeText: branding.welcomeText,
    idleMessage: branding.idleMessage,
    accentColor: branding.accentColor,
  };

  const customerSignupUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://basicuniformpos.com'}/customer-signup`;

  return (
    <CustomerDisplayClient
      storeName={branding.storeName}
      locationName={branding.locationName}
      branding={customerDisplayBranding}
      customerSignupUrl={customerSignupUrl}
    />
  );
}
