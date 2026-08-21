import type { Metadata } from "next";
import { SessionProvider } from "@/components/providers/SessionProvider";
import { Navbar } from "@/components/layout/Navbar";
import "./globals.css";

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
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 antialiased selection:bg-blue-100 selection:text-blue-900">
        <SessionProvider>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
