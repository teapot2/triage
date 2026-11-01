import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { fanoutIncident, fanoutIncidentRunning } from "@/lib/investigation/fanout-fixture";
import { FanoutPreview } from "./fanout-preview";

export const metadata: Metadata = { title: "Fan-out investigation · Triage" };

// The hand-written fan-out incident in the incident page's own view,
// finished or mid-run, to see the fan-out UI without running one. It's
// never saved, so it stays out of the incident list; its buttons call an
// API that doesn't know it. Development only: production 404s.
export default function FanoutPage() {
  if (process.env.NODE_ENV === "production") notFound();
  // The view reads the URL (?section=, ?state=), so it renders inside Suspense.
  return (
    <Suspense>
      <FanoutPreview finished={fanoutIncident} running={fanoutIncidentRunning} />
    </Suspense>
  );
}
