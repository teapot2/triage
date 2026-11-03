"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// How to set up the Slack bot, opened from its editor in Settings. The
// picture says what each token is for; the steps are the clicks in Slack's
// app settings, in the order Slack asks for them.
export function SlackBotGuide() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="rounded-sm text-foreground text-xs underline underline-offset-4 outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Setup guide
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up the Slack bot</DialogTitle>
          <DialogDescription>One thread per incident, and Approve or Deny from Slack. About ten minutes, once.</DialogDescription>
        </DialogHeader>

        <figure className="rounded-lg border bg-muted/30 px-3 py-4">
          <TokenDiagram />
        </figure>

        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li>
            Open your app at{" "}
            <a
              href="https://api.slack.com/apps"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4 hover:text-muted-foreground"
            >
              api.slack.com/apps
            </a>
            , or create one there.
          </li>
          <li>
            <Place>OAuth &amp; Permissions</Place>: add the <Code>chat:write</Code>, <Code>channels:read</Code> and{" "}
            <Code>users:read</Code> bot scopes, click <Place>Reinstall</Place>, and copy the{" "}
            <Place>Bot User OAuth Token</Place>. The last two let Settings show names instead of IDs.
          </li>
          <li>
            <Place>Socket Mode</Place>: turn it on. Copy the app-level token it creates with{" "}
            <Code>connections:write</Code> (later under <Place>Basic Information → App-Level Tokens</Place>).
          </li>
          <li>
            <Place>Interactivity &amp; Shortcuts</Place>: turn it on. No Request URL is needed with Socket Mode.
          </li>
          <li>
            In Slack, type <Code>/invite @yourapp</Code> in the channel, then copy the <Place>Channel ID</Place> at
            the bottom of its details.
          </li>
          <li>
            For each approver: their profile → ⋯ → <Place>Copy member ID</Place>.
          </li>
          <li>
            Paste them here, save, and <Place>Send test</Place>. Its <Place>Try a button</Place> checks the buttons.
          </li>
        </ol>

        <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground text-xs">
          <li>Without the app token or approvers, cards still post and update, with no buttons.</li>
          <li>Only approvers can decide from Slack. A fix that changes stored data is approved in Triage.</li>
          <li>One Triage per app token: Slack sends each click to one open connection.</li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}

const Place = ({ children }: { children: ReactNode }) => <span className="font-medium">{children}</span>;
const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-[0.85em]">{children}</code>;

// Triage and Slack, and the two ways between them, on a fixed 480 × 168 grid
// scaled to the dialog's width, in the theme's tokens. Both connections start
// from Triage, so it needs no public URL.
function TokenDiagram() {
  const line = "fill-none stroke-muted-foreground/50";
  const head = "fill-muted-foreground/60";
  return (
    <svg
      viewBox="0 0 480 168"
      className="mx-auto block w-full max-w-[480px] font-sans"
      role="img"
      aria-label="Triage posts cards to Slack with the bot token; Slack sends button clicks back over Socket Mode with the app token."
    >
      <path d="M140 56 H334" className={line} strokeWidth={1.25} />
      <path d="M334 52 L342 56 L334 60 Z" className={head} />
      <path d="M340 118 H146" className={line} strokeWidth={1.25} />
      <path d="M146 114 L138 118 L146 122 Z" className={head} />

      <Box x={8} label="Triage" note="your server" />
      <Box x={344} label="Slack" note="the channel" brand />

      <text x={240} y={44} textAnchor="middle" fontSize={12} fontWeight={600} className="fill-foreground">
        Posts and updates cards
      </text>
      <text x={240} y={74} textAnchor="middle" fontSize={10.5} className="fill-muted-foreground">
        bot token{" "}
        <tspan className="font-mono" fontSize={10}>
          xoxb-…
        </tspan>
      </text>
      <text x={240} y={106} textAnchor="middle" fontSize={12} fontWeight={600} className="fill-foreground">
        Button clicks
      </text>
      <text x={240} y={136} textAnchor="middle" fontSize={10.5} className="fill-muted-foreground">
        app token{" "}
        <tspan className="font-mono" fontSize={10}>
          xapp-…
        </tspan>{" "}
        · Socket Mode
      </text>
    </svg>
  );
}

function Box({ x, label, note, brand }: { x: number; label: string; note: string; brand?: boolean }) {
  return (
    <g>
      <rect
        x={x}
        y={24}
        width={128}
        height={120}
        rx={10}
        className={brand ? "fill-brand/15 stroke-brand/50" : "fill-background stroke-border"}
      />
      <text x={x + 64} y={81} textAnchor="middle" fontSize={13} fontWeight={600} className="fill-foreground">
        {label}
      </text>
      <text x={x + 64} y={99} textAnchor="middle" fontSize={10.5} className="fill-muted-foreground">
        {note}
      </text>
    </g>
  );
}
