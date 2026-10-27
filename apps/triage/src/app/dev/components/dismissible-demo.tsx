"use client";

import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// Dismissible notices for the gallery, one of them timed. "Show again"
// remounts them (a new key), and the count shows onDismiss firing.
export function DismissibleDemo() {
  const [round, setRound] = useState(0);
  const [dismissals, setDismissals] = useState(0);
  const count = () => setDismissals((n) => n + 1);

  return (
    <div className="flex w-full flex-col gap-3">
      <div key={round} className="flex flex-col gap-3">
        <Alert variant="info" dismissible onDismiss={count}>
          <AlertTitle>Replaying recorded telemetry</AlertTitle>
          <AlertDescription>This run uses a saved scenario, not live data.</AlertDescription>
        </Alert>
        <Alert variant="warning" dismissible dismissLabel="Dismiss warning" onDismiss={count}>
          <AlertTitle>Model credits expire Nov 4</AlertTitle>
          <AlertDescription>The hosted demo needs another way to pay for calls during judging.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline">
              Details
            </Button>
          </AlertAction>
        </Alert>
        <Alert variant="success" dismissible onDismiss={count}>
          <AlertTitle>Fix approved</AlertTitle>
        </Alert>
        <Alert variant="success" autoDismiss={8_000} dismissible onDismiss={count}>
          <AlertTitle>The model answered</AlertTitle>
          <AlertDescription>Closes itself after 8 s; hover or focus it to pause the countdown.</AlertDescription>
        </Alert>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setRound((r) => r + 1)}>
          <RotateCcwIcon /> Show again
        </Button>
        <span className="text-muted-foreground text-xs tabular-nums">onDismiss called {dismissals} times</span>
      </div>
    </div>
  );
}
