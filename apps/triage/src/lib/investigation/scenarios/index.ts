import { badDeploy } from "./bad-deploy";
import { healthy } from "./healthy";
import { liveRatings } from "./live-ratings";
import { poolLeak } from "./pool-leak";
import { priceGap } from "./price-gap";
import type { Scenario } from "./scenario-source";
import { trafficRush } from "./traffic-rush";
import { vulnerableDependency } from "./vulnerable-dependency";

export { createScenarioSource, type Expected, type Scenario } from "./scenario-source";

export const scenarios: Scenario[] = [poolLeak, priceGap, liveRatings, badDeploy, trafficRush, vulnerableDependency, healthy];

export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}
