import type { Metadata } from "next";
import { EndpointForm } from "@/components/watch/endpoint-form";

export const metadata: Metadata = { title: "New endpoint · Watch · Triage" };

export default function NewEndpointPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <EndpointForm />
    </div>
  );
}
