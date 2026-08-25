import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { SessionProvider } from "@/components/providers/SessionProvider";
import "./globals.css";

/**
 * Self-hosted by Next at build time — the font file ships from this app's own origin,
 * not a Google Fonts request at runtime. Works offline and behind a CSP that blocks
 * third-party font hosts. `variable` rather than the `className` shortcut so
 * tailwind.config's `fontFamily.sans` is the one place that decides where it applies,
 * instead of this file overriding every other font-family declaration by fiat.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "CodeMind",
  description: "An intelligent engineering workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-white font-sans text-gray-900 antialiased selection:bg-accent-100 selection:text-accent-900">
        <SessionProvider>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
