import type { ScenarioOption } from "@/hooks/use-start-investigation";
import { scenarios } from "./scenarios";

export const LIVE_ID = "live";

// What the Run investigation menus offer: the running Shopfront first, then
// the recorded scenarios (which work offline).
export const investigationOptions: ScenarioOption[] = [
  {
    id: LIVE_ID,
    label: "Live Shopfront",
    description: "Investigate the running store from its real telemetry",
    live: true,
  },
  ...scenarios.map(({ id, label, description }) => ({ id, label, description })),
];
