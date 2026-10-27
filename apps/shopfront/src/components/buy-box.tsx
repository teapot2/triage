import { CircleAlert } from "lucide-react";
import { logger } from "@/lib/logger";
import { getStockLevel, stockStatus, type StockStatus } from "@/lib/stock";
import { cn } from "@/lib/utils";
import { AddToCart } from "./add-to-cart";

const availability: Record<StockStatus, { dot: string; label: (n: number) => string }> = {
  in_stock: { dot: "bg-primary", label: () => "In stock, ships in 1–2 business days" },
  low: { dot: "bg-sale", label: (n) => `Only ${n} left` },
  sold_out: { dot: "bg-muted-foreground", label: () => "Sold out, back in stock soon" },
};

// Streams in after the rest of the page (it sits in a Suspense boundary), so
// a slow stock lookup holds up only this box. If the lookup fails, the box
// says so and adding to cart waits, since we can't promise what we can't see.
export async function BuyBox({ productId }: { productId: number }) {
  let onHand: number;
  try {
    onHand = await getStockLevel(productId);
  } catch (err) {
    logger.error("stock: lookup failed", { "product.id": productId, "error.message": String(err) });
    return (
      <div className="space-y-3">
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            <span className="font-medium">We can&apos;t check stock right now.</span>{" "}
            <span className="text-muted-foreground">Please refresh in a moment to add this to your cart.</span>
          </span>
        </p>
        <AddToCart productId={productId} onHand={0} unavailable />
      </div>
    );
  }

  const status = stockStatus(onHand);
  const { dot, label } = availability[status];
  return (
    <div className="space-y-4">
      <p className={cn("flex items-center gap-2 text-sm", status === "low" && "font-medium")}>
        <span className={cn("size-2 rounded-full", dot)} aria-hidden="true" />
        {label(onHand)}
      </p>
      <AddToCart productId={productId} onHand={onHand} />
    </div>
  );
}

export function BuyBoxSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Checking stock">
      <div className="h-5 w-56 animate-pulse rounded bg-secondary" />
      <div className="flex gap-3">
        <div className="h-12 w-32 animate-pulse rounded-lg bg-secondary" />
        <div className="h-12 flex-1 animate-pulse rounded-lg bg-secondary" />
      </div>
      <div className="h-5" />
    </div>
  );
}
