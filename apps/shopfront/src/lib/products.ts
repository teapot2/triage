import { and, asc, eq, ne } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db/client";
import { products } from "@/db/schema";

// Parses a route's id segment; anything but a positive integer is no product.
export const parseProductId = (raw: string) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
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
