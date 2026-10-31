import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { releaseStuck } from "@/db/pool-watch";
import { products } from "@/db/schema";
import { featureFlags, setFlag, type FeatureFlag } from "@/lib/flags";
import { logger } from "@/lib/logger";
import { opsEnabled, opsState } from "@/lib/ops";
import { setProfile, startTraffic, stopTraffic } from "@/lib/traffic";

export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

export function GET() {
  if (!opsEnabled()) return notFound();
  return Response.json(opsState());
}

type Action =
  | { action: "flag"; name: FeatureFlag; enabled: boolean }
  | { action: "traffic"; on: boolean }
  | { action: "profile"; profile: unknown }
  | { action: "release" };

// Every change is logged at warn, so it lands in the same log stream Triage
// reads, the way a deploy or a config push would.
export async function POST(req: Request) {
  if (!opsEnabled()) return notFound();
  const body = (await req.json().catch(() => null)) as Action | null;

  switch (body?.action) {
    case "flag": {
      if (!(body.name in featureFlags) || typeof body.enabled !== "boolean") break;
      // One fault at a time, so each run has one root cause to find.
      const other = body.enabled && opsState().flags.find((f) => f.enabled && f.name !== body.name);
      if (other) {
        return Response.json(
          { error: `“${other.label}” is already on. Turn it off first: only one fault runs at a time.` },
          { status: 409 },
        );
      }
      setFlag(body.name, body.enabled);
      logger.warn(`ops: ${body.name} turned ${body.enabled ? "on" : "off"}`, { "flag.name": body.name });
      return Response.json(opsState());
    }
    case "traffic": {
      if (typeof body.on !== "boolean") break;
      if (!body.on) {
        stopTraffic();
        return Response.json(opsState());
      }
      // The catalog comes from the database, so traffic can't start while the
      // pool is jammed. Stopping (above) always works.
      try {
        const rows = await db
          .select({ id: products.id, name: products.name, category: products.category, reviewCount: products.reviewCount })
          .from(products)
          .orderBy(asc(products.id));
        if (rows.length === 0) return Response.json({ error: "No products to visit. Run the seed." }, { status: 409 });
        startTraffic(new URL(req.url).origin, rows);
      } catch (err) {
        return Response.json({ error: `Couldn't load products: ${String(err)}` }, { status: 503 });
      }
      return Response.json(opsState());
    }
    case "profile": {
      // Takes any subset of the profile; the rest stays as it was.
      setProfile(body.profile);
      return Response.json(opsState());
    }
    case "release": {
      const released = releaseStuck();
      logger.warn("ops: released stuck pool connections", { "pool.released": released });
      return Response.json({ ...opsState(), released });
    }
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
}
