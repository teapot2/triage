import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { productPrices, products, stockLevels, type Product } from "@/db/schema";
import { isEnabled } from "@/lib/flags";

// Copies catalog prices into the price list, adding new products and
// updating changed prices. Only products we sell get a list price, so it
// takes the products inventory carries.
export async function syncListPrices() {
  return db
    .insert(productPrices)
    .select(
      db
        .select({ productId: products.id, amountCents: products.priceCents, updatedAt: sql`now()`.as("updated_at") })
        .from(products)
        .innerJoin(stockLevels, eq(stockLevels.productId, products.id)),
    )
    .onConflictDoUpdate({
      target: productPrices.productId,
      set: { amountCents: sql`excluded.amount_cents`, updatedAt: sql`now()` },
    })
    .returning({ productId: productPrices.productId });
}

// One product's price from the price list.
export async function getListPrice(productId: number): Promise<number> {
  const [{ amountCents }] = await db
    .select({ amountCents: productPrices.amountCents })
    .from(productPrices)
    .where(eq(productPrices.productId, productId))
    .limit(1);
  return amountCents;
}

// What a product sells for. FF_LIST_PRICES moves the product page, the
// product API and the cart over to the price list; listings keep the
// catalog price until it's rolled out.
export async function priceOf(product: Pick<Product, "id" | "priceCents">): Promise<number> {
  return isEnabled("FF_LIST_PRICES") ? getListPrice(product.id) : product.priceCents;
}
