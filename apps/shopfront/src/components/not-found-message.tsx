import Link from "next/link";
import { Button } from "@/components/ui/button";

export function NotFoundMessage() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="text-sm font-medium text-primary">404</p>
      <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight">We can&apos;t find that page</h1>
      <p className="mt-3 text-muted-foreground">It may have sold out for good, or the link is wrong.</p>
      <Button size="lg" asChild className="mt-8 h-11 px-5">
        <Link href="/#shop">Browse all products</Link>
      </Button>
    </div>
  );
}
