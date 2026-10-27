import { NotFoundMessage } from "@/components/not-found-message";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

// URLs that match no route. These render in the root layout, outside the
// store group, so the store chrome is added here.
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <NotFoundMessage />
      </main>
      <SiteFooter />
    </>
  );
}
