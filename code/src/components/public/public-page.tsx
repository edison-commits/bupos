import Link from "next/link";

const linkClass = "text-[#0b8279] underline decoration-[#0b8279]/30 underline-offset-4 hover:decoration-[#0b8279]";

export function PublicHeader() {
  return (
    <header className="border-b border-[#15201f]/15 bg-[#f4f1eb]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/demo/features" className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0b8279] font-black text-white">B</span>
          <span className="font-semibold tracking-[-0.02em]">BUPOS</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/demo/features" className="hidden text-[#30413d] hover:text-[#0b8279] sm:inline">Features</Link>
          <Link href="/pricing" className="hidden text-[#30413d] hover:text-[#0b8279] sm:inline">Pricing</Link>
          <Link href="/support" className="hidden text-[#30413d] hover:text-[#0b8279] sm:inline">Support</Link>
          <Link href="/demo" className="rounded-full bg-[#15201f] px-4 py-2 font-semibold text-white hover:bg-[#0b8279]">Try the demo</Link>
        </nav>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-[#15201f]/15 px-5 py-8 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 text-sm text-[#52605d] sm:flex-row sm:items-center sm:justify-between">
        <span>BasicUniformPOS · Web-first POS for uniform &amp; workwear retail · © 2026</span>
        <div className="flex flex-wrap gap-5">
          <Link href="/privacy" className="hover:text-[#0b8279]">Privacy</Link>
          <Link href="/terms" className="hover:text-[#0b8279]">Terms</Link>
          <Link href="/support" className="hover:text-[#0b8279]">Support</Link>
          <a href="mailto:hello@basicuniformpos.com" className="hover:text-[#0b8279]">Contact</a>
        </div>
      </div>
    </footer>
  );
}

export function PublicShell({ children }: { children: React.ReactNode }) {
  return <main className="min-h-[100dvh] bg-[#f4f1eb] text-[#15201f]"><PublicHeader />{children}<PublicFooter /></main>;
}

export { linkClass };
