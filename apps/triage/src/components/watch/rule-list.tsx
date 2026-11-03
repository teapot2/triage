"use client";

import { ChevronRightIcon, LoaderCircleIcon, PlusIcon, RadarIcon, RotateCcwIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SeverityBadge } from "@/components/incident/status-badges";
import {
  activeFacetCount,
  FilterChips,
  FilterMenu,
  type FilterValues,
} from "@/components/list-controls/filter-menu";
import { SearchInput } from "@/components/list-controls/search-input";
import { SortMenu } from "@/components/list-controls/sort-menu";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlParams } from "@/hooks/use-url-params";
import type { RuleState } from "@/lib/investigation/watch";
import { defaultRules, describeRule, type WatchRule } from "@/lib/investigation/watch-rule-model";
import {
  defaultRuleSort,
  filterRules,
  parseRuleSort,
  ruleFacetIds,
  ruleFacets,
  ruleSorts,
  ruleStatus,
} from "./rule-filters";
import { liveBadge, sentence, updateRules, useWatchState } from "./watch-client";
import { errorMessage } from "@/lib/errors";

// The Watch page's list of rules: each a row linking to the rule's own page,
// with its live status from the watch. Nothing here edits a rule; that's
// the rule's Edit page, so a stray click can't change one. Above it, the
// app's list controls (search, Filter, Sort), kept in the URL. Reads the
// URL, so the page renders it inside Suspense, with RuleListSkeleton.
export function WatchRuleList() {
  const [rules, setRules] = useState<WatchRule[]>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const watch = useWatchState();
  const { params, update, list } = useUrlParams();
  // The text is kept here as typed, and copied to the URL, so typing never
  // waits on the URL.
  const [query, setQuery] = useState(() => params.get("q") ?? "");

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/watch/rules", { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setRules(((await res.json()) as { rules: WatchRule[] }).rules);
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setLoadError(errorMessage(err));
      });
    return () => ctrl.abort();
  }, [attempt]);

  const states = new Map(watch?.rules.map((r) => [r.id, r]));

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load the watch rules</AlertTitle>
        <AlertDescription className="break-words">{loadError}</AlertDescription>
        <AlertAction>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setLoadError(undefined);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  if (!rules) return <RuleListSkeleton />;

  if (rules.length === 0) return <NoRules onRestore={setRules} />;

  const statusOf = (r: WatchRule) => ruleStatus(r, states.get(r.id), watch?.enabled);
  const facets = ruleFacets(rules, statusOf);
  const values: FilterValues = Object.fromEntries(ruleFacetIds.map((id) => [id, list(id)]));
  const sort = parseRuleSort(params.get("sort"));
  const shown = filterRules(rules, { query, facets: values, sort }, statusOf);
  const filtering = query.trim() !== "" || activeFacetCount(values) > 0;

  const search = (text: string) => {
    setQuery(text);
    update({ q: text.trim() ? text : null });
  };
  const clearAll = () => {
    setQuery("");
    update({ q: null, ...Object.fromEntries(ruleFacetIds.map((id) => [id, null])) });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {/* The search box gives way to its own row on narrow screens. */}
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={query} onChange={search} placeholder="Search rules" label="Search rules" className="min-w-48" />
          <div className="flex items-center gap-2">
            <FilterMenu facets={facets} values={values} onChange={update} />
            <SortMenu
              options={ruleSorts}
              value={sort}
              onChange={(s) => update({ sort: s === defaultRuleSort ? null : s })}
              noun="rules"
              variant="outline"
            />
          </div>
        </div>
        {filtering && (
          <FilterChips
            facets={facets}
            values={values}
            onChange={update}
            onClearAll={clearAll}
            shown={shown.length}
            total={rules.length}
          />
        )}
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-muted-foreground text-sm">No rules match.</p>
          <Button variant="outline" size="sm" onClick={clearAll}>
            Clear search and filters
          </Button>
        </div>
      ) : (
        <RuleRows rules={shown} states={states} watchOn={watch?.enabled} />
      )}
    </div>
  );
}

// The rules' placeholder while they load, and the page's Suspense fallback.
export function RuleListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton className="h-8 w-full" />
      <div className="divide-y rounded-lg border">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-56" />
          </div>
        ))}
      </div>
    </div>
  );
}

function RuleRows({
  rules,
  states,
  watchOn,
}: {
  rules: WatchRule[];
  states: Map<string, RuleState>;
  watchOn: boolean | undefined;
}) {
  return (
    <section aria-label="Rules" className="overflow-hidden rounded-lg border">
      <ul className="divide-y">
        {rules.map((rule) => (
          <li key={rule.id}>
            <Link
              href={`/watch/${rule.id}`}
              className="flex w-full items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 font-medium text-sm">
                  {rule.name}
                  <SeverityBadge severity={rule.severity} />
                </span>
                <span className="truncate text-muted-foreground text-xs">{sentence(describeRule(rule))}</span>
              </span>
              {liveBadge(rule, states.get(rule.id), watchOn)}
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// With every rule deleted, the way back: write one, or put back API latency,
// Page latency and Server errors. Restoring only happens here, where there's
// nothing for it to overwrite, so it needs no confirm; a rule edited into a
// bad state is fixed on its own Edit page, not by resetting them all.
function NoRules({ onRestore }: { onRestore: (rules: WatchRule[]) => void }) {
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string>();
  async function restore() {
    setRestoring(true);
    const result = await updateRules(() => defaultRules);
    setRestoring(false);
    if (result.rules) onRestore(result.rules);
    setError(result.error);
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-10 text-center">
        <RadarIcon className="mb-1 size-5 text-muted-foreground" aria-hidden />
        <p className="font-medium text-sm">No rules</p>
        <p className="text-muted-foreground text-sm">The watch has nothing to listen for until you add one.</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void restore()} disabled={restoring}>
            {restoring ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />}
            Restore default rules
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/watch/new">
              <PlusIcon />
              New rule
            </Link>
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setError(undefined)}>
          <AlertTitle>Couldn&apos;t restore the defaults</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
