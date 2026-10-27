"use client";

import { Check, CircleAlert, Minus, Plus } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { addToCart } from "@/app/(store)/cart/actions";
import { Button } from "@/components/ui/button";
import { MAX_PER_LINE } from "@/lib/cart-rules";

type Outcome = { ok: true; added: number } | { ok: false; error: string };

// `unavailable`: stock couldn't be read, so adding waits.
export function AddToCart({
  productId,
  onHand,
  unavailable = false,
}: {
  productId: number;
  onHand: number;
  unavailable?: boolean;
}) {
  const max = Math.min(onHand, MAX_PER_LINE);
  const [quantity, setQuantity] = useState(1);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  if (unavailable || max <= 0) {
    return (
      <Button size="lg" disabled className="h-12 w-full text-base">
        {unavailable ? "Add to cart" : "Sold out"}
      </Button>
    );
  }

  const change = (by: number) => {
    setQuantity((q) => Math.min(max, Math.max(1, q + by)));
    setOutcome(null);
  };

  const add = () =>
    startTransition(async () => {
      const result = await addToCart(productId, quantity);
      setOutcome(result.ok ? { ok: true, added: result.quantity } : result);
      if (result.ok) setQuantity(1);
    });

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <div className="flex h-12 items-center rounded-lg border bg-card" role="group" aria-label="Quantity">
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-full w-11 rounded-r-none"
            onClick={() => change(-1)}
            disabled={quantity <= 1}
            aria-label="Decrease quantity"
          >
            <Minus />
          </Button>
          <output aria-live="polite" className="w-8 text-center font-medium tabular-nums">
            {quantity}
          </output>
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-full w-11 rounded-l-none"
            onClick={() => change(1)}
            disabled={quantity >= max}
            aria-label="Increase quantity"
          >
            <Plus />
          </Button>
        </div>
        <Button size="lg" className="h-12 flex-1 text-base" onClick={add} disabled={pending}>
          {pending ? "Adding…" : "Add to cart"}
        </Button>
      </div>
      <p role="status" className="min-h-5 text-sm">
        {outcome?.ok === true && (
          <span className="flex flex-wrap items-center gap-x-1.5 text-primary animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none">
            <Check className="size-4" />
            Added {outcome.added} to your cart.
            <Link href="/cart" className="font-medium underline underline-offset-4">
              View cart
            </Link>
          </span>
        )}
        {outcome?.ok === false && (
          <span className="flex items-start gap-1.5 text-destructive animate-in fade-in-0 motion-reduce:animate-none">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {outcome.error}
          </span>
        )}
      </p>
    </div>
  );
}
