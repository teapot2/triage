import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { logger } from "@/lib/logger";
import { withListingRatings } from "@/lib/ratings";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = performance.now();
  const rows = await withListingRatings(await db.select().from(products).orderBy(asc(products.id)));
  logger.debug("listed products", { "products.count": rows.length, duration_ms: Math.round(performance.now() - started) });
  return Response.json(rows);
}
