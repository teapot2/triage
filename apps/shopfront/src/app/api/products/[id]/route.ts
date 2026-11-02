import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { logger } from "@/lib/logger";
import { priceOf } from "@/lib/prices";
import { parseProductId } from "@/lib/products";
import { getStockLevel } from "@/lib/stock";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const id = parseProductId(rawId);
  if (id === null) {
    logger.warn("products: rejected id", { "product.id.raw": rawId.slice(0, 40) });
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  logger.debug("fetched product", { "product.id": id, "product.found": Boolean(product) });

  if (!product) return Response.json({ error: "not found" }, { status: 404 });
  const priceCents = await priceOf(product);
  const stock = await getStockLevel(product.id);
  return Response.json({ ...product, priceCents, stock });
}
