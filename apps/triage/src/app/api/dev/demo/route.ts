import { removeDemoIncidents, seedDemoIncidents } from "@/lib/investigation/demo";

// Development only: add or remove the demo incidents (lib/investigation/demo).
const devOnly = () =>
  process.env.NODE_ENV === "production" ? Response.json({ error: "not found" }, { status: 404 }) : null;

export async function POST() {
  const blocked = devOnly();
  if (blocked) return blocked;
  return Response.json({ added: await seedDemoIncidents() });
}

export async function DELETE() {
  const blocked = devOnly();
  if (blocked) return blocked;
  return Response.json({ removed: await removeDemoIncidents() });
}
