import Link from "next/link";
import { Button } from "@/components/ui/button";

// Any page that isn't there (an incident, rule, endpoint or service that was
// deleted or never existed, a mistyped URL), inside the app's own frame.
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center">
        <p className="font-medium text-sm">Nothing here</p>
        <p className="max-w-sm text-muted-foreground text-sm">
          This page doesn&rsquo;t exist, or what it showed has been deleted. Check the link, or find it from the list.
        </p>
        <div className="mt-2 flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/">Incidents</Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/watch">Watch</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
