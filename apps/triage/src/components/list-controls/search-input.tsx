"use client";

import { SearchIcon, XIcon } from "lucide-react";
import type { Ref } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// A list's search box: a magnifier, × or Escape to clear, and while it's
// empty the key that focuses it (when the list has one). Escape with text
// clears only the text, so it doesn't also close what the list sits in.
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  shortcut,
  inputRef,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  shortcut?: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}) {
  return (
    <div className={cn("relative min-w-0 flex-1", className)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        className="h-8 pr-8 pl-8 text-sm"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : (
        shortcut && (
          <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border px-1 font-mono text-[10px] text-muted-foreground">
            {shortcut}
          </kbd>
        )
      )}
    </div>
  );
}
