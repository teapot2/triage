import { eq, notInArray, sql } from "drizzle-orm";
import { catalog, openingStock } from "@/lib/catalog";
import { syncListPrices } from "@/lib/prices";
import { db, pool } from "./client";
import { productPrices, products, reviews, stockLevels } from "./schema";

// Reviews written for each product. Stands in for a busy store's review
// history: years of orders, each one a chance of a review.
const REVIEWS_PER_PRODUCT = 50_000;

// What reviewers say, a phrase each.
const reviewPhrases = [
  "Lovely quality, just as pictured.",
  "Arrived quickly and well packed.",
  "Use it every day.",
  "Bought a second one as a gift.",
  "Even nicer in person.",
  "Good value for the price.",
  "Smaller than I expected, but well made.",
  "The colour is beautiful.",
  "Solid and well finished.",
  "Would buy again.",
];

// Rebuilds the reviews: REVIEWS_PER_PRODUCT for every product, dated over
// the last three years and rated 3 to 5 so each product's average lands
// near its catalog rating: 4% three stars, then the share of five stars
// that brings the average there, the rest four.
async function seedReviews() {
  await db.execute(sql`truncate table ${reviews} restart identity`);
  await db.execute(sql`
    insert into ${reviews} (product_id, rating, body, created_at)
    select p.id,
           case
             when g.u < 0.04 then 3
             when g.u < 1 - least(0.96, greatest(0, p.rating_tenths / 10.0 - 3.96)) then 4
             else 5
           end,
           (${sql.raw(`array[${reviewPhrases.map((p) => `'${p.replaceAll("'", "''")}'`).join(", ")}]`)})[1 + floor(g.v * ${reviewPhrases.length})::int],
           now() - g.w * interval '3 years'
      from ${products} p
     cross join lateral (
       select random() as u, random() as v, random() as w
         from generate_series(1, ${REVIEWS_PER_PRODUCT})
        where p.id is not null
     ) g`);
  await db.execute(sql`analyze ${reviews}`);
}

// Makes the products table match the catalog: inserts new products, updates
// the ones that exist (by name), and removes products no longer in it, such
// as the placeholder apparel from before the store had a brand. Stock is
// reset to the opening levels each time, then the price list is synced and
// the reviews rebuilt.
async function main() {
  const names = catalog.map((p) => p.name);
  const removed = await db.delete(products).where(notInArray(products.name, names)).returning({ id: products.id });

  for (const { name, ...details } of catalog) {
    const [row] = await db
      .insert(products)
      .values({ name, ...details })
      .onConflictDoUpdate({ target: products.name, set: details })
      .returning({ id: products.id });
    const onHand = openingStock[name];
    if (onHand === undefined) {
      // Unstocked on purpose (see openingStock): no row.
      await db.delete(stockLevels).where(eq(stockLevels.productId, row.id));
      continue;
    }
    await db
      .insert(stockLevels)
      .values({ productId: row.id, onHand })
      .onConflictDoUpdate({ target: stockLevels.productId, set: { onHand, updatedAt: new Date() } });
  }

  // The price list is rebuilt from the catalog prices.
  await db.delete(productPrices);
  const priced = await syncListPrices();
  await seedReviews();
  console.log(
    `seed: ${catalog.length} product(s) in the catalog, ${removed.length} removed, stock reset, ${priced.length} price(s) listed, ` +
      `${REVIEWS_PER_PRODUCT.toLocaleString("en-US")} review(s) each`,
  );
}

main()
  .catch((err) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
