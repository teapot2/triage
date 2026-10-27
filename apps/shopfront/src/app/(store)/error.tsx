"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

// Shown when a page fails to render, such as a product page while the
// database is down. The header and footer stay, so the store still looks
// like itself.
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="text-sm font-medium text-primary">Something went wrong</p>
      <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight">We couldn&apos;t load this page</h1>
      <p className="mt-3 text-muted-foreground">
        It&apos;s a problem on our side, not yours. Please try again in a minute.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Button size="lg" className="h-11 px-5" onClick={() => retry()}>
          Try again
        </Button>
        <Button size="lg" variant="outline" asChild className="h-11 bg-card px-5">
          <Link href="/">Back to the shop</Link>
        </Button>
      </div>
    </div>
  );
}
