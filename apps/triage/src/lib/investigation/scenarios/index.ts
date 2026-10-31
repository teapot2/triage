import { healthy } from "./healthy";
import { poolLeak } from "./pool-leak";
import { priceGap } from "./price-gap";
import type { Scenario } from "./scenario-source";

export { createScenarioSource, type Expected, type Scenario } from "./scenario-source";

export const scenarios: Scenario[] = [poolLeak, priceGap, healthy];

export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}
