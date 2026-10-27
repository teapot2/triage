import type { NewProduct } from "@/db/schema";

// Fernhill Goods' catalog: everyday home and kitchen goods. The seed writes
// it to the database; the pages read the database, so a database outage
// shows as one (which is the point of this app).

export const categories = ["Kitchen", "Tableware", "Home", "Linen"] as const;
export type Category = (typeof categories)[number];

// What each category is about, for its tile on the home page.
export const categoryBlurbs: Record<Category, string> = {
  Kitchen: "Boards, jars and pots for cooking every day",
  Tableware: "Stoneware and glass for the table",
  Home: "Vases, candles and planters",
  Linen: "Washed linen for the kitchen and table",
};

export const catalog: NewProduct[] = [
  {
    name: "Stoneware Mug",
    category: "Tableware",
    priceCents: 2400,
    description: "A wide, heavy mug in matte glaze, thrown to sit well in both hands.",
    ratingTenths: 48,
    reviewCount: 214,
    art: "mug",
    tint: "sage",
  },
  {
    name: "Speckled Serving Bowl",
    category: "Tableware",
    priceCents: 4800,
    description: "A shallow bowl in speckled oatmeal glaze, for salads and shared plates.",
    ratingTenths: 47,
    reviewCount: 96,
    art: "bowl",
    tint: "sand",
  },
  {
    name: "Linen Tea Towel Set",
    category: "Linen",
    priceCents: 3200,
    description: "Two stonewashed linen towels that dry fast and soften with every wash.",
    ratingTenths: 46,
    reviewCount: 158,
    art: "towel",
    tint: "clay",
  },
  {
    name: "Olive Wood Cutting Board",
    category: "Kitchen",
    priceCents: 5800,
    description: "Cut from a single piece of olive wood, oiled and ready to use.",
    ratingTenths: 49,
    reviewCount: 73,
    art: "board",
    tint: "sand",
  },
  {
    name: "Hand-thrown Bud Vase",
    category: "Home",
    priceCents: 3600,
    description: "A small vase for a single stem, each one slightly different.",
    ratingTenths: 47,
    reviewCount: 41,
    art: "vase",
    tint: "sky",
  },
  {
    name: "Beeswax Pillar Candle",
    category: "Home",
    priceCents: 2200,
    description: "Pure beeswax, hand-poured, burns clean for about 40 hours.",
    ratingTenths: 45,
    reviewCount: 187,
    art: "candle",
    tint: "honey",
  },
  {
    name: "Glass Storage Jar",
    category: "Kitchen",
    priceCents: 1800,
    description: "Borosilicate glass with an oak lid, for grains, coffee and tea.",
    ratingTenths: 44,
    reviewCount: 129,
    art: "jar",
    tint: "sky",
  },
  {
    name: "Ceramic Dinner Plates, Set of 2",
    category: "Tableware",
    priceCents: 4200,
    description: "Everyday plates with a raw rim, safe in the dishwasher and oven.",
    ratingTenths: 46,
    reviewCount: 88,
    art: "plate",
    tint: "sage",
  },
  {
    name: "Cast Iron Teapot",
    category: "Kitchen",
    priceCents: 7800,
    description: "Enamelled inside, with a stainless infuser. Keeps tea hot for an hour.",
    ratingTenths: 48,
    reviewCount: 64,
    art: "teapot",
    tint: "clay",
  },
  {
    name: "Ribbed Drinking Glasses, Set of 4",
    category: "Tableware",
    priceCents: 3400,
    description: "Thin, ribbed tumblers for water and juice, stackable.",
    ratingTenths: 45,
    reviewCount: 112,
    art: "glass",
    tint: "sky",
  },
  {
    name: "Linen Napkins, Set of 4",
    category: "Linen",
    priceCents: 2800,
    description: "Washed linen napkins in a soft, lived-in weave.",
    ratingTenths: 47,
    reviewCount: 69,
    art: "napkin",
    tint: "sage",
  },
  {
    name: "Terracotta Planter",
    category: "Home",
    priceCents: 3000,
    description: "Unglazed terracotta with a drainage hole and matching saucer.",
    ratingTenths: 46,
    reviewCount: 52,
    art: "planter",
    tint: "clay",
  },
];

// Units on hand when seeded, by product name. A spread on purpose: plenty,
// a few left, and one sold out, so every buy box state is on the shelf.
// The Cast Iron Teapot is left out: it has no stock row yet, which shows as
// sold out.
export const openingStock: Record<string, number> = {
  "Stoneware Mug": 64,
  "Speckled Serving Bowl": 18,
  "Linen Tea Towel Set": 41,
  "Olive Wood Cutting Board": 3,
  "Hand-thrown Bud Vase": 7,
  "Beeswax Pillar Candle": 120,
  "Glass Storage Jar": 85,
  "Ceramic Dinner Plates, Set of 2": 26,
  "Ribbed Drinking Glasses, Set of 4": 52,
  "Linen Napkins, Set of 4": 2,
  "Terracotta Planter": 33,
};

// What the pieces in each category are made of and how to look after them,
// for the product page's details.
export const categoryDetails: Record<Category, { materials: string; care: string }> = {
  Kitchen: {
    materials: "Wood, glass and cast iron from small workshops in Europe.",
    care: "Hand wash and dry straight away. Oil wooden pieces once a month.",
  },
  Tableware: {
    materials: "High-fired stoneware and soda-lime glass.",
    care: "Dishwasher and microwave safe. Avoid sudden changes in temperature.",
  },
  Home: {
    materials: "Hand-thrown ceramic, terracotta and pure beeswax.",
    care: "Wipe clean with a soft, damp cloth. Trim candle wicks to 5 mm.",
  },
  Linen: {
    materials: "100% European flax linen, stonewashed.",
    care: "Machine wash at 40°C, tumble dry low. Softens with every wash.",
  },
};

export const formatPrice = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
