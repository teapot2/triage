"use client";

import { DownloadIcon } from "lucide-react";
import { Fragment, useId } from "react";
import { toast } from "sonner";
import { type PaletteCommand, useRegisterCommands } from "@/components/command-registry";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Dataset, ExportFormat, ExportSubject } from "@/lib/export/dataset";
import { downloadRows, downloadUrl } from "@/lib/export/download";
import { formatInfo } from "@/lib/export/serialize";

// What one Export button offers: a server export, fetched as a plain link
// (/api/export/<id>, registered in lib/export/exports.ts), or rows the page
// already has, written in the browser. A dataset of any row type fits.
export type ExportSource =
  | { dataset: Dataset<never>; params: Record<string, string> }
  | { dataset: Dataset<never>; rows: readonly unknown[]; subject: ExportSubject };

export function exportHref(dataset: Pick<Dataset<never>, "id">, params: Record<string, string>, format: ExportFormat): string {
  return `/api/export/${dataset.id}?${new URLSearchParams({ format, ...params })}`;
}

// The page's export link, for a source and format, or the browser's
// writer. A failure in the browser is a toast, not a broken page.
function exportOf(source: ExportSource, format: ExportFormat) {
  if ("params" in source) return { href: exportHref(source.dataset, source.params, format) };
  return {
    run: () => {
      try {
        downloadRows(source.dataset as Dataset<unknown>, [...source.rows], source.subject, format);
      } catch (err) {
        toast.error(`Couldn't export ${source.dataset.name}`, { description: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

export function ExportMenu({
  exports,
  iconOnly = false,
  size = "sm",
}: {
  exports: ExportSource[];
  // For tight spots: the icon alone, its label for screen readers.
  iconOnly?: boolean;
  size?: "sm" | "xs" | "default";
}) {
  // One menu's commands per key; two menus on a page don't replace each other's.
  const key = `export-${useId()}`;
  useRegisterCommands(
    key,
    exports.flatMap((source) =>
      source.dataset.formats.map((format): PaletteCommand => {
        const target = exportOf(source, format);
        return {
          id: `${key}:${source.dataset.id}:${format}`,
          group: "Export",
          label: `Export ${source.dataset.name} as ${formatInfo[format].label}`,
          icon: DownloadIcon,
          keywords: `download ${format}`,
          run: () => (target.href ? downloadUrl(target.href) : target.run?.()),
        };
      }),
    ),
  );
  if (exports.length === 0) return null;
  const grouped = exports.length > 1;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={iconOnly ? (size === "default" ? "icon" : `icon-${size}`) : size} aria-label={iconOnly ? "Export" : undefined}>
          <DownloadIcon />
          {!iconOnly && "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {exports.map((source, i) => (
          <Fragment key={source.dataset.id}>
            {grouped && i > 0 && <DropdownMenuSeparator />}
            {grouped && <DropdownMenuLabel>{source.dataset.name}</DropdownMenuLabel>}
            {source.dataset.formats.map((format) => {
              const target = exportOf(source, format);
              const label = grouped ? formatInfo[format].label : `${source.dataset.name} · ${formatInfo[format].label}`;
              return target.href ? (
                <DropdownMenuItem key={format} asChild>
                  <a href={target.href} download>
                    {label}
                  </a>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={format} onSelect={target.run}>
                  {label}
                </DropdownMenuItem>
              );
            })}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
