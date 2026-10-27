import { cookies } from "next/headers";
import { MAX_LINES, MAX_PER_LINE } from "./cart-rules";

// The cart lives in a cookie: product ids and quantities only, so prices
// and names always come fresh from the database. No accounts, nothing
// stored server-side, and the server can render the header count on first
// paint.

export type CartLine = { productId: number; quantity: number };

const COOKIE = "cart";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

const isCount = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= max;

// Stored as [[id, qty], ...]. Anything malformed is dropped, not trusted.
export function parseCart(raw: string | undefined): CartLine[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is [number, number] =>
          Array.isArray(entry) && isCount(entry[0], Number.MAX_SAFE_INTEGER) && isCount(entry[1], MAX_PER_LINE),
      )
      .slice(0, MAX_LINES)
      .map(([productId, quantity]) => ({ productId, quantity }));
  } catch {
    return [];
  }
}

export async function readCart() {
  return parseCart((await cookies()).get(COOKIE)?.value);
}

// Only from Server Actions (cookies can't be set while rendering).
export async function writeCart(lines: CartLine[]) {
  const store = await cookies();
  if (lines.length === 0) {
    store.delete(COOKIE);
    return;
  }
  store.set(COOKIE, JSON.stringify(lines.map((l) => [l.productId, l.quantity])), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: THIRTY_DAYS,
  });
}

export const cartCount = (lines: CartLine[]) => lines.reduce((n, l) => n + l.quantity, 0);
