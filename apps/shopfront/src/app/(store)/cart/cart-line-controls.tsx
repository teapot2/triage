"use client";

import { CircleAlert, Minus, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { MAX_PER_LINE } from "@/lib/cart-rules";
import { cn } from "@/lib/utils";
import { removeFromCart, setQuantity, type CartResult } from "./actions";

export function CartLineControls({ productId, name, quantity }: { productId: number; name: string; quantity: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<CartResult>) =>
    startTransition(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) setError(result.error);
    });

  return (
    <div className="mt-auto pt-3">
      <div className={cn("flex items-center gap-4 transition-opacity", pending && "opacity-60")}>
        <div className="flex h-10 items-center rounded-lg border bg-card" role="group" aria-label={`Quantity of ${name}`}>
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-full w-10 rounded-r-none"
            disabled={pending || quantity <= 1}
            onClick={() => run(() => setQuantity(productId, quantity - 1))}
            aria-label={`Decrease quantity of ${name}`}
          >
            <Minus />
          </Button>
          <output aria-live="polite" className="w-7 text-center text-sm font-medium tabular-nums">
            {quantity}
          </output>
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-full w-10 rounded-l-none"
            disabled={pending || quantity >= MAX_PER_LINE}
            onClick={() => run(() => setQuantity(productId, quantity + 1))}
            aria-label={`Increase quantity of ${name}`}
          >
            <Plus />
          </Button>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => removeFromCart(productId))}
          className="min-h-10 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-60"
        >
          Remove<span className="sr-only"> {name}</span>
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
