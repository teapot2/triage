import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { products, reviews } from "@/db/schema";
import { isEnabled } from "@/lib/flags";

export type ListingRating = { ratingTenths: number; reviewCount: number };

// The star rating and review count each listed product shows. Live ratings
// (FF_LIVE_RATINGS) average the product's reviews on each listing, so new
// reviews show at once, rather than waiting for the stored rating_tenths
// and review_count to be updated. Off, listings show the stored ones.
export async function getListingRatings(productIds: number[]): Promise<Map<number, ListingRating>> {
  const ratings = new Map<number, ListingRating>();
  if (productIds.length === 0) return ratings;

  if (!isEnabled("FF_LIVE_RATINGS")) {
    const rows = await db
      .select({ id: products.id, ratingTenths: products.ratingTenths, reviewCount: products.reviewCount })
      .from(products)
      .where(inArray(products.id, productIds));
    for (const { id, ...rating } of rows) ratings.set(id, rating);
    return ratings;
  }

  for (const id of productIds) {
    const rows = await db.select({ rating: reviews.rating }).from(reviews).where(eq(reviews.productId, id));
    const total = rows.reduce((sum, r) => sum + r.rating, 0);
    ratings.set(id, {
      ratingTenths: rows.length ? Math.round((total / rows.length) * 10) : 0,
      reviewCount: rows.length,
    });
  }
  return ratings;
}

// Product rows with the rating their listing shows. A product with no
// rating to show keeps the one it has.
export async function withListingRatings<T extends { id: number } & ListingRating>(rows: T[]): Promise<T[]> {
  const ratings = await getListingRatings(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, ...ratings.get(r.id) }));
}
