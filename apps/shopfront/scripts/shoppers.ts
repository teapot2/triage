// Browser shoppers for the demo store: headless browsers that click through
// it the way customers do, so cart traffic (server actions, which a plain
// HTTP request can't call) shows up next to the page views that /ops sends.
// Each visit is a new visitor with an empty cart. Most shop: the home page,
// a product or two, often Add to cart, then sometimes the cart to change a
// quantity or remove a line. Some read: a help or company page from the
// footer, another from the side menu, now and then the contact form. Runs
// until Ctrl+C.
//
//   pnpm --filter @triage/shopfront shoppers                    # 2 shoppers on http://localhost:3001
//   pnpm --filter @triage/shopfront shoppers -- --users=4 --url=http://localhost:3001
//   pnpm --filter @triage/shopfront shoppers -- --headed        # watch them in a window
//   pnpm --filter @triage/shopfront shoppers -- --read=50 --add=80
//
// Options: --users (1 to 10, default 2); --read, the percent of visitors who
// read pages instead of shopping (default 25); --add, the percent of product
// views that end in Add to cart (default 55).
//
// Uses the installed Chrome. Without one, install Playwright's own:
// pnpm --filter @triage/shopfront exec playwright install chromium

import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [key, value] = a.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);
const baseURL = (args.url ?? "http://localhost:3001").replace(/\/+$/, "");
const users = Math.max(1, Math.min(10, Number(args.users ?? 2) || 2));
const headed = args.headed === "true";
const percent = (v: string | undefined, fallback: number) => Math.max(0, Math.min(100, Number(v ?? fallback) || 0)) / 100;
const readShare = percent(args.read, 25);
const addShare = percent(args.add, 55);

const chance = (p: number) => Math.random() < p;
const oneOf = <T>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];
// Mostly short pauses, now and then a long read: log-uniform between the two.
const pause = (page: Page, minS: number, maxS: number) => page.waitForTimeout(1000 * minS * (maxS / minS) ** Math.random());

const desktop: BrowserContextOptions = { viewport: { width: 1366, height: 820 } };
const phone: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
};

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: !headed });
  } catch {
    try {
      return await chromium.launch({ headless: !headed });
    } catch {
      console.error("No browser to run. Install Chrome, or: pnpm --filter @triage/shopfront exec playwright install chromium");
      process.exit(1);
    }
  }
}

// Opens a product from the links on the page, if there are any.
async function openProduct(page: Page, steps: string[]) {
  const links = page.locator('main a[href^="/products/"]');
  await links.first().waitFor({ timeout: 15_000 });
  const link = links.nth(Math.floor(Math.random() * (await links.count())));
  const href = await link.getAttribute("href");
  await link.click();
  await page.waitForURL(baseURL + href);
  steps.push((await page.locator("h1").innerText()).trim());
}

// Adds the product on the page to the cart, now and then more than one.
// True when the store took it.
async function addToCart(page: Page, steps: string[]) {
  const add = page.getByRole("button", { name: "Add to cart", exact: true });
  await add.waitFor({ timeout: 15_000 });
  if (!(await add.isEnabled())) {
    steps.push("(can't add)");
    return false;
  }
  if (chance(0.25)) await page.getByRole("button", { name: "Increase quantity", exact: true }).click();
  await add.click();
  // The line under the button says how it went once the server answers.
  const status = page.locator('p[role="status"]').filter({ hasText: /\S/ });
  await status.waitFor({ timeout: 15_000 });
  const outcome = (await status.innerText()).trim();
  const added = outcome.startsWith("Added");
  steps.push(added ? "added" : `not added: ${outcome}`);
  return added;
}

// Follows a link and notes the page it reached.
async function follow(page: Page, link: ReturnType<Page["locator"]>, steps: string[]) {
  const href = await link.getAttribute("href");
  await link.click();
  await page.waitForURL(baseURL + href);
  steps.push((await page.locator("h1").first().innerText()).trim());
}

// A reader: a footer page, maybe another from the side menu, and on the
// contact page now and then a message.
async function read(page: Page, steps: string[]) {
  const footerLinks = page.locator('footer a[href^="/"]:not([href*="#"]):not([href*="?"])');
  await follow(page, footerLinks.nth(Math.floor(Math.random() * (await footerLinks.count()))), steps);
  await pause(page, 4, 20);
  if (chance(0.5)) {
    const menu = page.locator("article").locator("..").locator('nav a:not([aria-current="page"])');
    await follow(page, menu.nth(Math.floor(Math.random() * (await menu.count()))), steps);
    await pause(page, 4, 20);
  }
  if (page.url().endsWith("/contact") && chance(0.4)) {
    await page.getByLabel("Name").fill(oneOf(["Sam Rivera", "Alex Chen", "Jordan Patel", "Robin Okafor"]));
    await page.getByLabel("Email").fill(`shopper${Math.floor(Math.random() * 1000)}@example.com`);
    await page.getByLabel("Message").fill(oneOf(["Do you ship to Alaska?", "Can I change my order?", "Is the bowl oven safe?"]));
    await pause(page, 2, 6);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText("Thanks, we've got your message").waitFor();
    steps.push("sent a message");
  }
}

async function visit(browser: Browser, steps: string[]) {
  const context = await browser.newContext({ baseURL, ...(chance(0.35) ? phone : desktop) });
  const page = await context.newPage();
  try {
    await page.goto("/", { waitUntil: "load" });
    steps.push("home");
    await pause(page, 2, 8);
    if (chance(readShare)) {
      await read(page, steps);
      return;
    }

    let inCart = 0;
    for (let products = chance(0.4) ? 2 : 1; products > 0; products--) {
      await openProduct(page, steps);
      await pause(page, 3, 15);
      if (chance(addShare) && (await addToCart(page, steps))) inCart++;
      await pause(page, 1, 5);
    }

    if (inCart > 0 && chance(0.7)) {
      await page.locator('header a[href="/cart"]').first().click();
      await page.waitForURL(/\/cart/);
      steps.push("cart");
      await pause(page, 2, 8);
      const action = Math.random();
      if (action < 0.35) {
        await page.getByRole("button", { name: /^Increase quantity of / }).first().click();
        steps.push("+1");
      } else if (action < 0.55) {
        await page.getByRole("button", { name: /^Remove / }).first().click();
        steps.push("removed");
      }
      await pause(page, 2, 5);
    }
  } finally {
    await context.close();
  }
}

async function shopper(browser: Browser, n: number) {
  // Staggered, so the shoppers don't move in step.
  await new Promise((resolve) => setTimeout(resolve, (n - 1) * 3000));
  while (!stopping) {
    const steps: string[] = [];
    try {
      await visit(browser, steps);
      console.log(`[shopper ${n}] ${steps.join(" → ")}`);
    } catch (err) {
      if (stopping) return;
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      console.warn(`[shopper ${n}] ${steps.join(" → ")} ✗ ${message}`);
    }
    // The next visitor along, a few seconds later.
    await new Promise((resolve) => setTimeout(resolve, 1000 * oneOf([1, 2, 4, 8])));
  }
}

let stopping = false;

async function main() {
  const browser = await launch();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping…");
    await browser.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`${users} browser ${users === 1 ? "shopper" : "shoppers"} on ${baseURL}. Ctrl+C to stop.`);
  await Promise.all(Array.from({ length: users }, (_, i) => shopper(browser, i + 1)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
