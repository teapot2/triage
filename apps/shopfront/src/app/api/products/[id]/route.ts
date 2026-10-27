import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { logger } from "@/lib/logger";
import { getStockLevel } from "@/lib/stock";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  logger.info("fetched product", { "product.id": id, "product.found": Boolean(product) });

  if (!product) return Response.json({ error: "not found" }, { status: 404 });
  const stock = await getStockLevel(product.id);
  return Response.json({ ...product, stock });
}
