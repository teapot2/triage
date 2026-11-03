import type { LiveSlo, LiveSloRoute } from "@/lib/live/types";
import { defineDataset } from "../dataset";

// The service page's error budgets: one row per SLO rule and route it
// covers, as the page shows them.

export type SloBudgetRow = LiveSloRoute & Pick<LiveSlo, "name" | "objectivePercent" | "windowDays" | "latencyMs">;

export const sloBudgetRows = (slos: LiveSlo[]): SloBudgetRow[] =>
  slos.flatMap(({ name, objectivePercent, windowDays, latencyMs, routes }) =>
    routes.map((r) => ({ ...r, name, objectivePercent, windowDays, latencyMs })),
  );

export const sloBudget = defineDataset<SloBudgetRow>({
  id: "slo-budget",
  name: "Error budgets",
  columns: [
    { key: "rule", value: (r) => r.name },
    { key: "method", value: (r) => r.method },
    { key: "route", value: (r) => r.route },
    { key: "objective_percent", value: (r) => r.objectivePercent },
    { key: "window_days", value: (r) => r.windowDays },
    { key: "latency_ms", value: (r) => r.latencyMs },
    { key: "requests", value: (r) => r.requests },
    { key: "budget_left_percent", value: (r) => r.budgetLeftPercent },
    { key: "burn_1h", value: (r) => r.burn1h },
    { key: "burn_6h", value: (r) => r.burn6h },
    { key: "alert", value: (r) => r.alert },
  ],
  formats: ["csv", "json"],
});
