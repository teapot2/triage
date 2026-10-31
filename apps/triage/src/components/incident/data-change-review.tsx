"use client";

import { DatabaseIcon } from "lucide-react";
import { useId } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { JOURNAL, patchChanges, patchFor } from "@/lib/investigation/fix/data-change";
import type { DataChange, Fix } from "@/lib/investigation/schema";

// What a SQL file in the fix says: a new one whole, an edited one as its
// diff hunks. The part's first two lines are its ---/+++ header; git's
// "\ No newline at end of file" markers are left out.
export function sqlText(fix: Fix, file: string): string {
  const part = patchFor(fix.patch, [file]);
  const body = part
    .split("\n")
    .slice(2)
    .filter((l) => !l.startsWith("\\"));
  if (!patchChanges(part)[0]?.created) return body.join("\n");
  return body
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1))
    .join("\n");
}

// The data half of a fix, for the approver to read before approving: why
// Triage thinks it changes stored data, the SQL the sandbox never ran, and
// the box they tick to say they've read it. The code half is proven as
// usual; this part runs against production only once the PR ships.
export function DataChangeReview({
  fix,
  change,
  reviewed,
  onReviewedChange,
}: {
  fix: Fix;
  change: DataChange;
  reviewed: boolean;
  onReviewedChange: (reviewed: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Alert variant="warning" icon={<DatabaseIcon />}>
        <AlertTitle>Changes stored data</AlertTitle>
        <AlertDescription className="flex flex-col gap-1.5">
          <ul className="list-disc pl-4 wrap-anywhere">
            {change.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <span>
            The sandbox only reads the database, so it can&apos;t prove this part. It runs against production when the
            PR is deployed.
          </span>
        </AlertDescription>
      </Alert>
      {change.unproven.map((file) => (
        <div key={file} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">
              <span className="font-mono">{file}</span>
              {file === JOURNAL && <span className="text-muted-foreground"> · written by Triage</span>}
            </span>
            <Badge variant="warning" className="shrink-0">
              Not proven in the sandbox
            </Badge>
          </div>
          <pre className="max-h-[min(12rem,25dvh)] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed">
            {sqlText(fix, file)}
          </pre>
        </div>
      ))}
      <label htmlFor={id} className="flex items-center gap-2 font-medium text-sm">
        <Checkbox id={id} checked={reviewed} onCheckedChange={(checked) => onReviewedChange(checked === true)} />
        I&apos;ve reviewed the data change
      </label>
    </div>
  );
}
