import { LoaderCircleIcon, PlayIcon, SearchIcon, SplitIcon, TrashIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { HttpStatusBadge, LogLevelBadge, MetricBadges, TestResultBadge } from "@/components/incident/outcome-badges";
import { IncidentStatusBadge, SeverityBadge, SeverityMeter } from "@/components/incident/status-badges";
import { ThemeSelect } from "@/components/theme-select";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ProgressRing } from "@/components/ui/progress-ring";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Incident, IncidentStatus } from "@/lib/investigation/schema";
import { BrandPreview } from "./brand-preview";
import { DemoData } from "./demo-data";
import { DismissibleDemo } from "./dismissible-demo";

export const metadata: Metadata = { title: "Components · Triage" };

const buttonVariants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;
const buttonSizes = ["xs", "sm", "default", "lg"] as const;
const badgeVariants = ["default", "secondary", "outline", "ghost", "destructive", "success", "warning", "info"] as const;
const statuses: IncidentStatus[] = ["investigating", "diagnosed", "awaiting_approval", "resolved", "healthy", "failed"];
const severities: Incident["severity"][] = ["sev1", "sev2", "sev3", "sev4"];

// A gallery of the UI components in their variants and states, to check how
// they look together and in both themes. Development only: production 404s.
export default function ComponentsPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-4 pt-2 pb-16 md:pt-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading font-semibold text-2xl tracking-tight">Components</h1>
          <p className="text-muted-foreground text-sm">Development only. Switch the theme to check both.</p>
        </div>
        <ThemeSelect aria-label="Theme" />
      </header>

      <Section title="Demo data" source="lib/investigation/demo.ts, fanout-fixture.ts">
        <Row label="30 incidents, every status">
          <DemoData />
        </Row>
        <Row label="Fan-out incident">
          <Button size="sm" variant="secondary" asChild>
            <Link href="/dev/fanout">
              <SplitIcon /> Open the fan-out fixture
            </Link>
          </Button>
        </Row>
      </Section>

      <Section title="Brand colour" source="dev/components/brand-preview.tsx">
        <Row label="Primary, focus, selection, logo">
          <BrandPreview />
        </Row>
      </Section>

      <Section title="Notice" source="ui/alert.tsx">
        <Row label="Variants">
          <div className="flex w-full flex-col gap-3">
            <Alert variant="destructive">
              <AlertTitle>Investigation failed</AlertTitle>
              <AlertDescription>No accepted report after 30 model steps.</AlertDescription>
            </Alert>
            <Alert variant="warning">
              <AlertTitle>Model credits expire Nov 4</AlertTitle>
              <AlertDescription>The hosted demo needs another way to pay for calls during judging.</AlertDescription>
            </Alert>
            <Alert variant="success">
              <AlertTitle>Fix approved</AlertTitle>
              <AlertDescription>The pull request is ready for review.</AlertDescription>
            </Alert>
            <Alert variant="info">
              <AlertTitle>Replaying recorded telemetry</AlertTitle>
              <AlertDescription>This run uses a saved scenario, not live data.</AlertDescription>
            </Alert>
            <Alert>
              <AlertTitle>Default</AlertTitle>
              <AlertDescription>Neutral, with no icon.</AlertDescription>
            </Alert>
          </div>
        </Row>
        <Row label="Title only">
          <Alert variant="info" className="w-full">
            <AlertTitle>Investigation queued</AlertTitle>
          </Alert>
        </Row>
        <Row label="With action">
          <Alert variant="destructive" className="w-full">
            <AlertTitle>Couldn&apos;t reach the model</AlertTitle>
            <AlertDescription>The request timed out after 30 s.</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline">
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </Row>
        <Row label="Long text">
          <Alert variant="warning" className="w-full">
            <AlertTitle>Some evidence could not be verified</AlertTitle>
            <AlertDescription>
              Two claims cite evidence IDs that no tool returned, so they are struck through in the reasoning.
              The verdict still stands on the remaining evidence, but treat the struck claims as unconfirmed
              until the investigation is run again.
            </AlertDescription>
          </Alert>
        </Row>
        <Row label="No icon">
          <Alert variant="success" icon={false} className="w-full">
            <AlertTitle>Saved</AlertTitle>
          </Alert>
        </Row>
        <Row label="Dismissible">
          <DismissibleDemo />
        </Row>
      </Section>

      <Section title="Button" source="ui/button.tsx">
        <Row label="Variants">
          {buttonVariants.map((v) => (
            <Button key={v} variant={v}>
              {v}
            </Button>
          ))}
        </Row>
        <Row label="Sizes">
          {buttonSizes.map((s) => (
            <Button key={s} size={s} variant="outline">
              {s}
            </Button>
          ))}
        </Row>
        <Row label="With icon">
          <Button>
            <PlayIcon /> Run investigation
          </Button>
          <Button variant="outline" size="icon" aria-label="Search">
            <SearchIcon />
          </Button>
          <Button variant="destructive" size="sm">
            <TrashIcon /> Delete
          </Button>
        </Row>
        <Row label="States">
          <Button disabled>Disabled</Button>
          <Button variant="outline" disabled>
            Disabled outline
          </Button>
          <Button disabled>
            <LoaderCircleIcon className="animate-spin" /> Loading
          </Button>
        </Row>
      </Section>

      <Section title="Badge" source="ui/badge.tsx, incident/status-badges.tsx">
        <Row label="Variants">
          {badgeVariants.map((v) => (
            <Badge key={v} variant={v}>
              {v}
            </Badge>
          ))}
        </Row>
        <Row label="Status badge">
          <StatusBadge tone="success">Ready</StatusBadge>
          <StatusBadge tone="warning">Needs key</StatusBadge>
          <StatusBadge tone="destructive">Error</StatusBadge>
          <StatusBadge tone="info">Info</StatusBadge>
          <StatusBadge tone="muted">Not running</StatusBadge>
          <StatusBadge tone="muted" loading>
            Checking
          </StatusBadge>
          <StatusBadge tone="warning" pulse>
            Live
          </StatusBadge>
        </Row>
        <Row label="Incident status">
          {statuses.map((s) => (
            <IncidentStatusBadge key={s} status={s} />
          ))}
        </Row>
        <Row label="Severity">
          {severities.map((s) => (
            <SeverityBadge key={s} severity={s} />
          ))}
        </Row>
        <Row label="Severity meter">
          {severities.map((s) => (
            <SeverityMeter key={s} severity={s} />
          ))}
        </Row>
        <Row label="Test result">
          <TestResultBadge exitCode={0} />
          <TestResultBadge exitCode={1} />
        </Row>
        <Row label="Alert value">
          <MetricBadges observed={3036} threshold={500} unit="ms" />
          <MetricBadges observed={124} threshold={500} unit="ms" />
        </Row>
        <Row label="HTTP status">
          {[200, 302, 404, 500].map((s) => (
            <HttpStatusBadge key={s} status={s} />
          ))}
          <HttpStatusBadge status={200} latencyMs={42} />
          <HttpStatusBadge status={503} latencyMs={3004} />
        </Row>
        <Row label="Log level">
          {(["debug", "info", "warn", "error"] as const).map((l) => (
            <LogLevelBadge key={l} level={l} />
          ))}
        </Row>
      </Section>

      <Section title="Input" source="ui/input.tsx">
        <Row label="States">
          <div className="grid w-full gap-3 sm:grid-cols-2">
            <Input placeholder="Search tool calls" aria-label="Default" />
            <Input defaultValue="query_logs" aria-label="Filled" />
            <Input placeholder="Disabled" disabled aria-label="Disabled" />
            <Input defaultValue="not-an-id" aria-invalid aria-label="Invalid" />
          </div>
        </Row>
      </Section>

      <Section title="Tabs" source="ui/tabs.tsx">
        <Row label="Default">
          <Tabs defaultValue="diff">
            <TabsList>
              <TabsTrigger value="diff">Diff</TabsTrigger>
              <TabsTrigger value="sandbox">Sandbox output</TabsTrigger>
              <TabsTrigger value="disabled" disabled>
                Disabled
              </TabsTrigger>
            </TabsList>
            <TabsContent value="diff" className="pt-2 text-muted-foreground text-sm">
              Diff panel
            </TabsContent>
            <TabsContent value="sandbox" className="pt-2 text-muted-foreground text-sm">
              Sandbox panel
            </TabsContent>
          </Tabs>
        </Row>
        <Row label="Line">
          <Tabs defaultValue="diff">
            <TabsList variant="line">
              <TabsTrigger value="diff">Diff</TabsTrigger>
              <TabsTrigger value="sandbox">Sandbox output</TabsTrigger>
            </TabsList>
          </Tabs>
        </Row>
      </Section>

      <Section title="Progress" source="ui/progress.tsx">
        <Row label="Values">
          <div className="grid w-full gap-3">
            {[0, 35, 86, 100].map((v) => (
              <div key={v} className="flex items-center gap-3">
                <span className="w-10 font-mono text-muted-foreground text-xs tabular-nums">{v}%</span>
                <Progress value={v} aria-label={`${v} percent`} />
              </div>
            ))}
          </div>
        </Row>
      </Section>

      <Section title="Progress ring" source="ui/progress-ring.tsx">
        <Row label="Values">
          {[0, 0.004, 0.35, 0.72, 0.9, 1].map((v) => (
            <span key={v} className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs tabular-nums">
              <ProgressRing
                value={v}
                aria-label={`${v * 100} percent`}
                className={v >= 0.85 ? "text-destructive" : v >= 0.7 ? "text-warning" : undefined}
              />
              {Math.round(v * 1000) / 10}%
            </span>
          ))}
        </Row>
        <Row label="Sizes">
          {["size-3", "size-4", "size-5", "size-7"].map((size) => (
            <ProgressRing key={size} value={0.42} className={size} />
          ))}
        </Row>
      </Section>

      <Section title="Card" source="ui/card.tsx">
        <Row label="Default">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>Connection leak in getStockLevel</CardTitle>
              <CardDescription>Root cause · 86% confidence</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              Release the pooled client in a finally block so every return path gives it back.
            </CardContent>
          </Card>
        </Row>
      </Section>

      <Section title="Tooltip" source="ui/tooltip.tsx">
        <Row label="Hover or focus">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">Approve fix</Button>
            </TooltipTrigger>
            <TooltipContent>Opens a PR changing 2 files. Nothing touches production until you merge it.</TooltipContent>
          </Tooltip>
        </Row>
      </Section>

      <Section title="Skeleton" source="ui/skeleton.tsx">
        <Row label="Loading">
          <div className="flex w-full flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        </Row>
      </Section>
    </div>
  );
}

function Section({ title, source, children }: { title: string; source: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4 border-b pb-2">
        <h2 className="font-heading font-medium text-base">{title}</h2>
        <code className="font-mono text-muted-foreground text-xs">{source}</code>
      </div>
      <div className="flex flex-col divide-y">{children}</div>
    </section>
  );
}

// A labelled row of examples: the label on the left at desktop width, above
// on phones.
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 py-4 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-6">
      <span className="pt-1.5 text-muted-foreground text-xs">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
