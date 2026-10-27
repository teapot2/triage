"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// A demo store has no mailing list, so signing up only acknowledges it.
// Nothing is sent or stored.
export function NewsletterForm() {
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <p role="status" className="mt-4 flex items-center gap-2 text-sm text-primary">
        <Check className="size-4" /> Thanks, you&apos;re on the list.
      </p>
    );
  }
  return (
    <form
      className="mt-4 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setDone(true);
      }}
    >
      <label htmlFor="newsletter-email" className="sr-only">
        Email address
      </label>
      <Input id="newsletter-email" type="email" required placeholder="you@example.com" className="h-9 bg-card" />
      <Button type="submit" size="lg">
        Sign up
      </Button>
    </form>
  );
}
