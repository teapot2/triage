import { Star } from "lucide-react";
import Link from "next/link";
import type { Product } from "@/db/schema";
import { formatPrice } from "@/lib/catalog";
import { Badge } from "./ui/badge";
import { ProductImage } from "./product-image";

// Enough reviews to call it a bestseller in a catalog this size.
const BESTSELLER_REVIEWS = 150;

export function ProductCard({ product }: { product: Product }) {
  const rating = (product.ratingTenths / 10).toFixed(1);
  return (
    <Link href={`/products/${product.id}`} className="group block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
      <div className="relative aspect-square overflow-hidden rounded-lg bg-secondary">
        <ProductImage
          name={product.name}
          art={product.art}
          sizes="(min-width: 1024px) 25vw, 50vw"
          tint={product.tint}
          className="transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
        />
        {product.reviewCount >= BESTSELLER_REVIEWS && (
          <Badge variant="secondary" className="absolute top-3 left-3 bg-card/90 backdrop-blur">
            Bestseller
          </Badge>
        )}
      </div>
      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium leading-snug group-hover:underline group-hover:underline-offset-4">
            {product.name}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{product.category}</p>
        </div>
        <p className="text-sm font-medium tabular-nums">{formatPrice(product.priceCents)}</p>
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
        <Star className="size-3.5 fill-star text-star" aria-hidden="true" />
        <span className="sr-only">Rated</span>
        <span className="font-medium text-foreground tabular-nums">{rating}</span>
        <span className="sr-only">out of 5,</span>
        <span className="tabular-nums">({product.reviewCount.toLocaleString("en-US")})</span>
        <span className="sr-only">reviews</span>
      </p>
    </Link>
  );
}
