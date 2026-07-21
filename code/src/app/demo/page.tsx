import type { Metadata } from "next";
import { DemoConsole } from "@/components/demo/demo-console";

export const metadata: Metadata = {
  title: "Interactive BUPOS Demo | BasicUniformPOS",
  description: "Explore a simulated BUPOS retail register with safe demo data. No account or login required.",
  robots: { index: false, follow: false, noarchive: true },
};

export default function DemoPage() {
  return <DemoConsole />;
}
