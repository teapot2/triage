import type { Metadata } from "next";
import { Fraunces, Geist } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces" });

export const metadata: Metadata = {
  title: { default: "Fernhill Goods: everyday home and kitchen goods", template: "%s · Fernhill Goods" },
  description: "Stoneware, linen, wood and glass for the kitchen and table, made by small workshops.",
};

// Just the document. The store's header and footer live in (store)/layout;
// /ops has its own plain shell.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${fraunces.variable}`}>
      <body className="flex min-h-svh flex-col font-sans">{children}</body>
    </html>
  );
}
