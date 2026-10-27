"use client";

import { Command } from "cmdk";
import {
  ArrowLeftIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PlayIcon,
  ServerIcon,
  SearchIcon,
  SettingsIcon,
  SirenIcon,
  SunIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { type PaletteCommand, useCommandRegistry } from "@/components/command-registry";
import { formatAgo } from "@/components/incident/format";
import { StatusDot, statusLabel } from "@/components/incident/status-badges";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { useRecentlyViewed } from "@/hooks/use-seen";
import { type ScenarioOption, useStartInvestigation } from "@/hooks/use-start-investigation";
import { useTheme } from "@/hooks/use-theme";
import type { ThemePreference } from "@/lib/theme";
import type { RecentIncident } from "./app-sidebar-nav";

const pages: { label: string; href: string; icon: LucideIcon }[] = [
  { label: "Incidents", href: "/", icon: SirenIcon },
  { label: "Services", href: "/services", icon: ServerIcon },
  { label: "Settings", href: "/settings", icon: SettingsIcon },
];

const themes: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

const subscribeNever = () => () => {};

// ⌘ on a Mac, Ctrl elsewhere (the convention on Windows and Linux). The
// server can't tell, so it renders Ctrl and a Mac switches after hydration.
function useIsMac() {
  return useSyncExternalStore(
    subscribeNever,
    () => /mac|iphone|ipad/i.test(navigator.userAgent),
    () => false,
  );
}

// The sidebar's Search row and the palette it opens, toggled from anywhere
// with ⌘K / Ctrl+K. With nothing typed it offers what's likely next: the
// current page's commands, incidents needing attention, ones viewed lately,
// actions and pages. Typing searches all of them, plus every incident.
export function SearchCommand({
  incidents,
  attention,
  scenarios,
  now,
}: {
  incidents: RecentIncident[];
  attention: RecentIncident[];
  scenarios: ScenarioOption[];
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // What the current page offers, collected when the palette opens.
  const [pageCommands, setPageCommands] = useState<PaletteCommand[]>([]);
  // A scenario picked to run, waiting for a second confirming Enter.
  const [confirm, setConfirm] = useState<ScenarioOption | null>(null);
  const registry = useCommandRegistry();
  const router = useRouter();
  const pathname = usePathname();
  const isMac = useIsMac();
  const viewed = useRecentlyViewed();
  const { preference, setPreference } = useTheme();
  const { setOpenMobile, toggleSidebar, isMobile, state: sidebarState } = useSidebar();
  const run = useStartInvestigation();
  const mod = isMac ? "⌘" : "Ctrl ";

  const show = () => {
    setPageCommands(registry?.collect() ?? []);
    setSearch("");
    setConfirm(null);
    setOpen(true);
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (open) setOpen(false);
      else show();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const close = () => {
    setOpen(false);
    setOpenMobile(false);
  };
  const go = (href: string) => {
    close();
    router.push(href);
  };
  const runCommand = (c: PaletteCommand) => {
    close();
    c.run();
  };

  const browsing = search.trim() === "";
  const currentId = pathname.match(/^\/incidents\/([^/]+)/)?.[1];
  const byId = new Map(incidents.map((i) => [i.id, i]));
  const recentlyViewed = viewed
    .filter((id) => id !== currentId)
    .map((id) => byId.get(id))
    .filter((i): i is RecentIncident => i !== undefined)
    .slice(0, 5);
  const commandGroups = [...Map.groupBy(pageCommands.filter((c) => !browsing || c.pinned), (c) => c.group)];

  const incidentItem = (i: RecentIncident, group: string) => (
    <Command.Item
      key={`${group}-${i.id}`}
      value={`${group} ${i.label} ${i.title} ${i.id} ${i.service} ${statusLabel[i.status]}`}
      onSelect={() => go(`/incidents/${i.id}`)}
      className={itemClass}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <StatusDot status={i.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{i.label}</span>
        <span className="truncate text-muted-foreground text-xs">
          {i.service} · {statusLabel[i.status]} · {formatAgo(i.at, now)}
        </span>
      </span>
    </Command.Item>
  );

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={show} tooltip={`Search (${mod}K)`}>
          <SearchIcon />
          <span>Search</span>
          <kbd className="ml-auto rounded border px-1 font-mono text-[10px] text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden max-md:hidden">
            {mod}K
          </kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
          <Dialog.Content
            // Esc on the confirm step goes back instead of closing.
            onEscapeKeyDown={(e) => {
              if (!confirm) return;
              e.preventDefault();
              setConfirm(null);
            }}
            className="fixed top-[15vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <Dialog.Title className="sr-only">Search</Dialog.Title>
            <Dialog.Description className="sr-only">Find an incident or a page, or run a command</Dialog.Description>
            <Command loop filter={matchWords} shouldFilter={!confirm} className="flex flex-col">
              <div className="flex items-center gap-2 border-b px-3">
                <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                <Command.Input
                  autoFocus
                  value={confirm ? "" : search}
                  onValueChange={(v) => !confirm && setSearch(v)}
                  readOnly={confirm !== null}
                  placeholder={
                    confirm ? "Enter to run, Esc to go back" : "Search incidents, evidence, actions and pages"
                  }
                  className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <kbd className="shrink-0 rounded border px-1 font-mono text-[10px] text-muted-foreground">Esc</kbd>
              </div>
              <Command.List className="max-h-[min(60vh,26rem)] overflow-y-auto p-1.5">
                {confirm ? (
                  <Command.Group heading={`Run “${confirm.label}”?`} className={groupClass}>
                    <p className="px-2 pb-2 text-muted-foreground text-xs">
                      Replays recorded telemetry through the agent. It calls the model, which may incur charges,
                      and creates a new incident.
                    </p>
                    <Command.Item
                      value="confirm-run"
                      disabled={run.pending}
                      onSelect={async () => {
                        if (await run.start(confirm.id)) close();
                      }}
                      className={itemClass}
                    >
                      {run.pending ? <LoaderCircleIcon className={iconClass} /> : <PlayIcon className={iconClass} />}
                      {run.pending ? "Starting…" : "Run investigation"}
                      <Hint>Enter</Hint>
                    </Command.Item>
                    <Command.Item value="confirm-back" onSelect={() => setConfirm(null)} className={itemClass}>
                      <ArrowLeftIcon className={iconClass} />
                      Back
                      <Hint>Esc</Hint>
                    </Command.Item>
                    {run.error && <p className="px-2 pt-2 text-destructive text-xs">{run.error}</p>}
                  </Command.Group>
                ) : (
                  <>
                    <Command.Empty className="px-3 py-6 text-center text-muted-foreground text-sm">
                      Nothing matches.
                    </Command.Empty>

                    {commandGroups.map(([group, commands]) => (
                      <Command.Group key={group} heading={group} className={groupClass}>
                        {commands.map((c) => {
                          const Icon = c.icon;
                          return (
                            <Command.Item
                              key={c.id}
                              value={`${group} ${c.label} ${c.keywords ?? ""}`}
                              onSelect={() => runCommand(c)}
                              className={itemClass}
                            >
                              {Icon && <Icon className={iconClass} />}
                              <span className="min-w-0 flex-1 truncate">{c.label}</span>
                              {c.hint && <Hint>{c.hint}</Hint>}
                            </Command.Item>
                          );
                        })}
                      </Command.Group>
                    ))}

                    {browsing && attention.length > 0 && (
                      <Command.Group heading="Needs attention" className={groupClass}>
                        {attention.map((i) => incidentItem(i, "attention"))}
                      </Command.Group>
                    )}
                    {browsing && recentlyViewed.length > 0 && (
                      <Command.Group heading="Recently viewed" className={groupClass}>
                        {recentlyViewed.map((i) => incidentItem(i, "viewed"))}
                      </Command.Group>
                    )}
                    {!browsing && (
                      <Command.Group heading="Incidents" className={groupClass}>
                        {incidents.map((i) => incidentItem(i, "incident"))}
                      </Command.Group>
                    )}

                    <Command.Group heading="Actions" className={groupClass}>
                      {scenarios.map((s) => (
                        <Command.Item
                          key={s.id}
                          value={`action run investigation new ${s.label} ${s.description}`}
                          onSelect={() => setConfirm(s)}
                          className={itemClass}
                        >
                          <PlayIcon className={iconClass} />
                          <span className="min-w-0 flex-1 truncate">Run investigation: {s.label}</span>
                          <Hint>Confirm</Hint>
                        </Command.Item>
                      ))}
                      {themes.map(({ value, label, icon: Icon }) => (
                        <Command.Item
                          key={value}
                          value={`action theme appearance ${label}`}
                          onSelect={() => {
                            setPreference(value);
                            close();
                          }}
                          className={itemClass}
                        >
                          <Icon className={iconClass} />
                          <span className="min-w-0 flex-1 truncate">Theme: {label}</span>
                          {preference === value && <Hint>Current</Hint>}
                        </Command.Item>
                      ))}
                      {!isMobile && (
                        <Command.Item
                          value="action toggle sidebar collapse expand"
                          onSelect={() => {
                            toggleSidebar();
                            close();
                          }}
                          className={itemClass}
                        >
                          <PanelLeftIcon className={iconClass} />
                          <span className="min-w-0 flex-1 truncate">
                            {sidebarState === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
                          </span>
                          <Hint>{mod}B</Hint>
                        </Command.Item>
                      )}
                    </Command.Group>

                    <Command.Group heading="Pages" className={groupClass}>
                      {pages.map(({ label, href, icon: Icon }) => (
                        <Command.Item key={href} value={`page go ${label}`} onSelect={() => go(href)} className={itemClass}>
                          <Icon className={iconClass} />
                          {label}
                        </Command.Item>
                      ))}
                    </Command.Group>
                  </>
                )}
              </Command.List>
            </Command>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto shrink-0 pl-2 text-muted-foreground text-xs">{children}</span>;
}

// Every word typed must appear somewhere in the item; cmdk's default fuzzy
// match also accepts scattered letters ("control" matched "Connection leak
// ... pool"), which is noise in a short list of similar titles. Results then
// rank by how closely they match: the whole phrase as typed ("evidence 4"
// in "Evidence 4 · ..."), then every word at the start of a word, then
// words found anywhere ("4" inside "412x").
function matchWords(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const phrase = search.toLowerCase().trim().replace(/\s+/g, " ");
  const words = phrase.split(" ").filter(Boolean);
  if (!words.every((w) => haystack.includes(w))) return 0;
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const atWordStart = (w: string) => new RegExp(`(^|[^a-z0-9])${escape(w)}`).test(haystack);
  const wholeWord = (w: string) => new RegExp(`(^|[^a-z0-9])${escape(w)}($|[^a-z0-9])`).test(haystack);
  if (wholeWord(phrase)) return 1;
  if (words.every(atWordStart)) return 0.6;
  return 0.3;
}

const iconClass = "size-4 shrink-0 text-muted-foreground";
const groupClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:text-xs";
const itemClass =
  "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled=true]:cursor-default data-[disabled=true]:opacity-60 data-[selected=true]:bg-primary/10 data-[selected=true]:text-brand";
