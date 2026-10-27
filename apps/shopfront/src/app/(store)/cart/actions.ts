"use server";

import { refresh } from "next/cache";
import { readCart, writeCart } from "@/lib/cart";
import { MAX_LINES, MAX_PER_LINE } from "@/lib/cart-rules";
import { logger } from "@/lib/logger";
import { getStockLevel } from "@/lib/stock";

export type CartResult = { ok: true; quantity: number } | { ok: false; error: string };

const valid = (n: number, max: number) => Number.isInteger(n) && n > 0 && n <= max;

// How many of a product can be in the cart: what's on the shelf, up to the
// per-line cap. Throws if stock can't be read; callers turn that into a
// message rather than guessing.
async function limitFor(productId: number) {
  return Math.min(await getStockLevel(productId), MAX_PER_LINE);
}

const stockError = "We couldn't check stock just now, so your cart wasn't changed. Please try again.";

// Adds `quantity` more of a product. Returns how many were actually added,
// which can be fewer than asked when stock or the cap runs out.
export async function addToCart(productId: number, quantity: number): Promise<CartResult> {
  if (!valid(productId, Number.MAX_SAFE_INTEGER) || !valid(quantity, MAX_PER_LINE)) {
    return { ok: false, error: "That quantity isn't available." };
  }
  const lines = await readCart();
  const line = lines.find((l) => l.productId === productId);
  if (!line && lines.length >= MAX_LINES) {
    return { ok: false, error: `Your cart is full (${MAX_LINES} different products).` };
  }

  let limit: number;
  try {
    limit = await limitFor(productId);
  } catch (err) {
    logger.error("cart: stock check failed", { "product.id": productId, "error.message": String(err) });
    return { ok: false, error: stockError };
  }
  const had = line?.quantity ?? 0;
  const next = Math.min(had + quantity, limit);
  if (next <= had) {
    return {
      ok: false,
      error: limit === 0 ? "Sorry, this just sold out." : `You already have the most we can sell you (${limit}).`,
    };
  }

  await writeCart(line ? lines.map((l) => (l === line ? { ...l, quantity: next } : l)) : [...lines, { productId, quantity: next }]);
  logger.info("cart: added", { "product.id": productId, "cart.quantity": next });
  refresh();
  return { ok: true, quantity: next - had };
}

// Sets a line's quantity from the cart page. Raising it checks stock;
// lowering it never needs to.
export async function setQuantity(productId: number, quantity: number): Promise<CartResult> {
  if (!valid(quantity, MAX_PER_LINE)) return { ok: false, error: "That quantity isn't available." };
  const lines = await readCart();
  const line = lines.find((l) => l.productId === productId);
  if (!line) return { ok: false, error: "That item is no longer in your cart." };

  if (quantity > line.quantity) {
    try {
      const limit = await limitFor(productId);
      if (quantity > limit) return { ok: false, error: limit === 0 ? "Sorry, this just sold out." : `Only ${limit} available.` };
    } catch (err) {
      logger.error("cart: stock check failed", { "product.id": productId, "error.message": String(err) });
      return { ok: false, error: stockError };
    }
  }

  await writeCart(lines.map((l) => (l === line ? { ...l, quantity } : l)));
  refresh();
  return { ok: true, quantity };
}

export async function removeFromCart(productId: number): Promise<CartResult> {
  const lines = await readCart();
  await writeCart(lines.filter((l) => l.productId !== productId));
  refresh();
  return { ok: true, quantity: 0 };
}
