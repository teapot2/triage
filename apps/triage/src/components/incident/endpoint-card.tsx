"use client";

import { ActivityIcon, ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { Timestamp } from "@/components/timestamp";
import { useEndpointDetail } from "@/components/watch/endpoint-client";
import { Button } from "@/components/ui/button";
import type { Incident } from "@/lib/investigation/schema";
import { parseRuleId } from "@/lib/investigation/uptime/model";
import { plural } from "@/components/watch/watch-client";
import { formatDateTime } from "./format";

// What an uptime incident records about its episode.
type Uptime = NonNullable<Incident["uptime"]>;

// The check behind an uptime incident: its URL, the rule that tripped in
// words, how many checks have failed so far and when the last did (or when
// it recovered), and a link to the check's page. Nothing for the incidents
// the traffic rules open.
export function EndpointCard({ incident }: { incident: Incident }) {
  const rule = incident.trigger.rule;
  const parsed = rule && parseRuleId(rule.id);
  const uptime = incident.uptime;
  if (!rule || !parsed) return null;
  return <EndpointCardBody checkId={parsed.checkId} description={rule.description} uptime={uptime} />;
}

function EndpointCardBody({ checkId, description, uptime }: { checkId: string; description: string; uptime?: Uptime }) {
  // The check as it is now; gone if it was deleted since.
  const { data, missing } = useEndpointDetail(checkId);
  const check = data?.check;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ActivityIcon className="size-3.5" />
          Endpoint check{check && ` · ${check.name}`}
        </span>
        {check && (
          <Button variant="ghost" size="xs" asChild>
            <Link href={`/watch/endpoints/${checkId}`}>
              View endpoint <ArrowRightIcon />
            </Link>
          </Button>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Fact label="URL">
          {check ? (
            <span className="break-all font-mono text-xs">{check.url}</span>
          ) : missing ? (
            <span className="text-muted-foreground">This endpoint was deleted.</span>
          ) : (
            <span className="text-muted-foreground">…</span>
          )}
        </Fact>
        <Fact label="Rule">{description.charAt(0).toUpperCase() + description.slice(1)}</Fact>
        {uptime && (
          <>
            <Fact label="Failing checks">{plural(uptime.failedChecks, "check", "checks")} so far</Fact>
            {uptime.recoveredAt ? (
              <Fact label="Recovery">
                Recovered at <Timestamp date={uptime.recoveredAt}>{formatDateTime(uptime.recoveredAt)}</Timestamp>
              </Fact>
            ) : (
              uptime.lastFailedAt && (
                <Fact label="Last failure">
                  <Timestamp date={uptime.lastFailedAt} />
                </Fact>
              )
            )}
          </>
        )}
      </dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
