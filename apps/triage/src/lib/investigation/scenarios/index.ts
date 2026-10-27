import { healthy } from "./healthy";
import { poolLeak } from "./pool-leak";
import type { Scenario } from "./scenario-source";

export { createScenarioSource, type Scenario } from "./scenario-source";

export const scenarios: Scenario[] = [poolLeak, healthy];

export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}
