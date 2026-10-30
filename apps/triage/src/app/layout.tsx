import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandRegistryProvider } from "@/components/command-registry";
import { SidebarStateScript } from "@/components/sidebar-state-script";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CodeFontSync } from "@/hooks/use-code-font-size";
import { ColorThemeSync } from "@/hooks/use-color-theme";
import { SpeechSync } from "@/hooks/use-speech";
import { ThemeSync } from "@/hooks/use-theme";
import { codeFontScript } from "@/lib/code-font";
import { colorThemeScript } from "@/lib/color-theme";
import { themeScript } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Triage",
  description: "AI SRE for teams with no SRE",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // The theme scripts set the `dark` class, color-scheme and
    // data-color-theme on <html> before React hydrates, so its attributes
    // differ from the server's on purpose; suppressHydrationWarning covers
    // this element only.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* Injected into <head> and run before hydration (Next's way to run
            an inline script early), so the page paints in the saved theme. */}
        <Script id="theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        <Script id="color-theme" strategy="beforeInteractive">
          {colorThemeScript}
        </Script>
        <Script id="code-font" strategy="beforeInteractive">
          {codeFontScript}
        </Script>
        <ThemeSync />
        <ColorThemeSync />
        <CodeFontSync />
        {/* Reads the URL (usePathname), which prerendering only has at request
            time; Suspense lets the rest of the page render ahead of it. */}
        <Suspense>
          <SpeechSync />
        </Suspense>
        <TooltipProvider>
          <CommandRegistryProvider>
            <SidebarProvider>
              <AppSidebar />
              <SidebarStateScript />
              <SidebarInset className="min-w-0">
                <div className="flex h-12 shrink-0 items-center px-4 sm:px-6 md:hidden">
                  <SidebarTrigger aria-label="Open sidebar" className="-ml-1.5 text-muted-foreground" />
                </div>
                {children}
              </SidebarInset>
            </SidebarProvider>
          </CommandRegistryProvider>
        </TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
