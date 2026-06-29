import type { Metadata } from 'next';
import { CustomerSignupForm } from './customer-signup-form';

export const metadata: Metadata = {
  title: 'Customer Signup | BasicUniformPOS',
  description: 'Save your sizes and style preferences for faster checkout.',
};

export const dynamic = 'force-dynamic';

export default async function CustomerSignupPage() {
  let storeName = 'Basic Uniform';
  const orgId = process.env.BUPOS_ORG_ID;
  if (orgId) {
    try {
      const { readCustomerDisplayBranding } = await import('@/lib/persistence/store');
      const branding = await readCustomerDisplayBranding(orgId);
      storeName = branding.storeName;
    } catch {
      // Keep the public signup page available even if store branding is temporarily unavailable.
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-white">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-teal-300">{storeName}</p>
          <h1 className="mt-3 text-3xl font-black">Save your sizes</h1>
          <p className="mt-2 text-sm text-slate-300">
            Share your fit and style preferences so checkout is faster next time.
          </p>
        </div>
        <CustomerSignupForm />
      </div>
    </main>
  );
}
