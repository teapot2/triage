import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { logger } from "@/lib/logger";
import { withListingRatings } from "@/lib/ratings";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await withListingRatings(await db.select().from(products).orderBy(asc(products.id)));
  logger.info("listed products", { "products.count": rows.length });
  return Response.json(rows);
}
