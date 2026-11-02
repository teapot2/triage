import { and, asc, eq, ne } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db/client";
import { products } from "@/db/schema";

// Parses a route's id segment: digits only. Number() on its own would also
// take a sign, an exponent, a radix prefix or stray whitespace, so "12 " and
// "1e2" would find products. Anything else is no product.
export const parseProductId = (raw: string) => {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
};

// Cached per request, so the page and its metadata share one query.
export const getProduct = cache(async (id: number) => {
  const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return row ?? null;
});

export async function getRelated(category: string, excludeId: number, limit = 4) {
  return db
    .select()
    .from(products)
    .where(and(eq(products.category, category), ne(products.id, excludeId)))
    .orderBy(asc(products.id))
    .limit(limit);
}
