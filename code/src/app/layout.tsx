import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import { NoticeToaster } from "@/components/notice-toaster";
import { SwUpdateBanner } from "@/components/sw-update-banner";
import "./globals.css";

export const viewport: Viewport = {
  // Microsoft Fluent / Azure blue — matches --surface-accent so the
  // mobile browser chrome + PWA splash tint with the brand colour.
  themeColor: "#0078d4",
};

export const metadata: Metadata = {
  title: "BasicUniformPOS",
  description: "Web-first retail POS for casualwear and uniform stores.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
  },
  icons: {
    apple: "/icon-192.png",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      className="h-full bg-[var(--surface-app)] text-[var(--text-primary)] antialiased"
    >
      <head>
        {/*
          R35-P7: FOUC elimination — apply the POS theme class before paint.
          Before this, `register-console-client.tsx` flipped the class in a
          `useEffect` that runs after hydration. A user with the "dark" theme
          saved saw ~200-400ms of light-mode flash on every cold render
          (hard reload of /register, tab reopen, offline re-launch).
          Reading localStorage in a blocking <head> script + mutating
          documentElement classList pre-paint is the standard fix.
          Wrapped in try/catch because localStorage throws in Safari
          private mode. The nonce passes the strict CSP set by the
          edge middleware.
        */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('pos-theme');" +
              "if(t==='dark'){document.documentElement.classList.add('dark');}" +
              "else if(t==='high-contrast'){document.documentElement.setAttribute('data-theme','high-contrast');}" +
              "}catch(e){}})();",
          }}
        />
      </head>
      <body className="min-h-full font-sans">
        {children}
        <Toaster richColors />
        <Suspense>
          <NoticeToaster />
        </Suspense>
        {/* R40-7: new-SW banner so users explicitly opt into an update
            rather than a `skipWaiting` takeover mid-session. */}
        <SwUpdateBanner />
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}`,
          }}
        />
      </body>
    </html>
  );
}
