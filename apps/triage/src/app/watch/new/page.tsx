import type { Metadata } from "next";
import { RuleForm } from "@/components/watch/rule-form";

export const metadata: Metadata = { title: "New rule · Watch · Triage" };

export default function NewRulePage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <RuleForm />
    </div>
  );
}
