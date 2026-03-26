import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BasicUniformPOS",
  description: "Web-first retail POS for casualwear and uniform stores.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
  },
  themeColor: "#0d9488",
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
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}`,
          }}
        />
      </body>
    </html>
  );
}
