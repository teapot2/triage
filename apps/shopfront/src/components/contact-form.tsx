"use client";

import { Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const topics = ["An order", "A return", "A product", "Wholesale", "Something else"];

const fieldClass =
  "w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

// Like the newsletter form, a demo store has no inbox: sending only
// acknowledges the message. Nothing is sent or stored.
export function ContactForm() {
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <p role="status" className="flex items-center gap-2 rounded-xl border bg-card p-4 text-sm text-primary">
        <Check className="size-4 shrink-0" /> Thanks, we&apos;ve got your message and will reply within one business
        day.
      </p>
    );
  }
  return (
    <form
      className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        setSent(true);
      }}
    >
      <Field label="Name" htmlFor="contact-name">
        <Input id="contact-name" name="name" autoComplete="name" required className="h-10 bg-card" />
      </Field>
      <Field label="Email" htmlFor="contact-email">
        <Input id="contact-email" name="email" type="email" autoComplete="email" required className="h-10 bg-card" />
      </Field>
      <Field label="About" htmlFor="contact-topic">
        <select id="contact-topic" name="topic" className={`${fieldClass} h-10`}>
          {topics.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Order number (optional)" htmlFor="contact-order">
        <Input id="contact-order" name="order" placeholder="FG-10234" className="h-10 bg-card" />
      </Field>
      <Field label="Message" htmlFor="contact-message" className="sm:col-span-2">
        <textarea id="contact-message" name="message" required rows={5} className={`${fieldClass} py-2`} />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" size="lg" className="h-10 px-5">
          Send message
        </Button>
      </div>
    </form>
  );
}

function Field({ label, htmlFor, className, children }: { label: string; htmlFor: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
