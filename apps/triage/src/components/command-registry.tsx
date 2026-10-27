"use client";

import type { LucideIcon } from "lucide-react";
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef, useState } from "react";

// A command the search palette can run: what a page offers while it's open,
// like the incident page's "Approve fix".
export interface PaletteCommand {
  id: string;
  // The palette's heading for it, e.g. "This incident".
  group: string;
  label: string;
  icon?: LucideIcon;
  // Extra words to match on, e.g. an evidence ID.
  keywords?: string;
  // Shown on the right, e.g. a shortcut or "Current".
  hint?: string;
  // Listed with nothing typed; the rest only show when searching.
  pinned?: boolean;
  run: () => void;
}

interface Registry {
  register: (key: string, commands: RefObject<PaletteCommand[]>) => () => void;
  collect: () => PaletteCommand[];
}

const RegistryContext = createContext<Registry | null>(null);

// Pages register commands while mounted; the palette collects them when it
// opens. Entries are refs, read on open rather than during render, so
// registering never re-renders anything.
export function CommandRegistryProvider({ children }: { children: ReactNode }) {
  const [registry] = useState<Registry>(() => {
    const entries = new Map<string, RefObject<PaletteCommand[]>>();
    return {
      register(key, commands) {
        entries.set(key, commands);
        return () => {
          if (entries.get(key) === commands) entries.delete(key);
        };
      },
      collect: () => [...entries.values()].flatMap((r) => r.current),
    };
  });
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

// Offers `commands` to the palette under `key` while the caller is mounted;
// the latest list is what the palette sees when it opens.
export function useRegisterCommands(key: string, commands: PaletteCommand[]) {
  const registry = useContext(RegistryContext);
  const ref = useRef(commands);
  useEffect(() => {
    ref.current = commands;
  });
  useEffect(() => registry?.register(key, ref), [registry, key]);
}

export function useCommandRegistry() {
  return useContext(RegistryContext);
}
