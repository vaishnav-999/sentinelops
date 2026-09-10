import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SimulationProvider } from "@/components/providers/simulation-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "SentinelOps — Autonomous Monitoring & Self-Healing",
  description:
    "Mission control for software infrastructure: observe, detect, understand, remediate, verify.",
};

export const viewport: Viewport = {
  themeColor: "#07090D",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // Dark only. `suppressHydrationWarning` guards the html attrs since the
      // theme is fixed at the root and never toggled on the client.
      suppressHydrationWarning
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="bg-bg text-text min-h-full">
        <SimulationProvider>{children}</SimulationProvider>
      </body>
    </html>
  );
}
