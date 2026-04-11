import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Toaster } from "sonner";
import { NoticeToaster } from "@/components/notice-toaster";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#0d9488",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full bg-[var(--surface-app)] text-[var(--text-primary)] antialiased"
    >
      <body className="min-h-full font-sans">
        {children}
        <Toaster richColors />
        <Suspense>
          <NoticeToaster />
        </Suspense>
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}`,
          }}
        />
      </body>
    </html>
  );
}
