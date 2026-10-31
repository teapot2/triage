import Link from "next/link";
import { categories } from "@/lib/catalog";
import { infoSections } from "@/lib/info-pages";
import { NewsletterForm } from "./newsletter-form";

const columns = [
  {
    title: "Shop",
    links: [
      ...categories.map((c) => ({ label: c, href: `/?category=${encodeURIComponent(c)}#shop` })),
      { label: "All products", href: "/#shop" },
    ],
  },
  ...infoSections,
];

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t bg-secondary/60">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-10 px-4 py-12 sm:grid-cols-3 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="col-span-2 max-w-sm sm:col-span-3 md:col-span-1">
          <p className="font-serif text-xl font-semibold">Fernhill Goods</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Everyday goods from small workshops. New pieces and the odd sale, about once a month.
          </p>
          <NewsletterForm />
        </div>
        {columns.map((col) => (
          <div key={col.title}>
            <h2 className="text-sm font-medium">{col.title}</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="transition-colors hover:text-foreground">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-muted-foreground sm:px-6">© 2026 Fernhill Goods</p>
      </div>
    </footer>
  );
}
