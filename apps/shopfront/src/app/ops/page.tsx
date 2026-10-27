import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { opsEnabled, opsState } from "@/lib/ops";
import { OpsPanel } from "./ops-panel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Ops", robots: { index: false } };

export default function OpsPage() {
  if (!opsEnabled()) notFound();
  return <OpsPanel initial={opsState()} triageUrl={process.env.TRIAGE_URL ?? "http://localhost:3000"} />;
}
