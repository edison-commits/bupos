import Link from "next/link";
import type { ReactNode } from "react";

export function PublicInfoPage({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-[100dvh] bg-[#f4f1eb] text-[#15201f]">
      <header className="border-b border-[#15201f]/15">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <Link href="/demo/features" className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0b8279] font-black text-white">B</span>
            <span className="font-semibold tracking-[-0.02em]">BUPOS</span>
          </Link>
          <nav aria-label="Public navigation" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[#30413d]">
            <Link href="/demo/features" className="hover:text-[#0b8279]">Product</Link>
            <Link href="/demo" className="hover:text-[#0b8279]">Demo</Link>
            <Link href="/support" className="hover:text-[#0b8279]">Support</Link>
            <Link href="/login" className="rounded-full bg-[#15201f] px-4 py-2 text-white hover:bg-[#0b8279]">Sign in</Link>
          </nav>
        </div>
      </header>

      <article className="mx-auto max-w-4xl px-5 py-14 sm:px-8 sm:py-20">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#0b8279]">{eyebrow}</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.05em] sm:text-6xl">{title}</h1>
        <p className="mt-6 max-w-3xl text-lg leading-8 text-[#405552]">{intro}</p>
        <p className="mt-4 text-sm text-[#52605d]">Updated August 24, 2026</p>
        <div className="mt-12 space-y-10 text-base leading-7 text-[#30413d]">{children}</div>
      </article>

      <footer className="border-t border-[#15201f]/15 px-5 py-8 sm:px-8">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 text-sm text-[#52605d] sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 BasicUniformPOS</span>
          <nav aria-label="Trust and support" className="flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/privacy" className="hover:text-[#0b8279]">Privacy</Link>
            <Link href="/terms" className="hover:text-[#0b8279]">Terms</Link>
            <Link href="/support" className="hover:text-[#0b8279]">Support</Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
