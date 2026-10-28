"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type ListParams, type PageSize, pageSizes, savePageSize } from "./list-params";
import { useListNavigation } from "./use-list-navigation";

// "Rows per page [10]", as in Calendly's, Pinterest's and Chatbase's list
// footers. Changing it keeps the first row on screen in view: from rows
// 21–30 at 10 a page, 25 a page opens rows 1–25, not page 3 of the new size.
// The choice is saved first, so the request for the new rows carries it.
export function PageSizeSelect({ params }: { params: ListParams }) {
  const { pending, go } = useListNavigation();
  const choose = (value: string) => {
    const size = Number(value) as PageSize;
    savePageSize(size);
    go({ ...params, size, page: Math.floor(((params.page - 1) * params.size) / size) + 1 });
  };

  return (
    <label className="flex items-center gap-2 text-muted-foreground text-sm">
      Rows per page
      <Select value={String(params.size)} onValueChange={choose}>
        <SelectTrigger size="sm" className="tabular-nums text-foreground" aria-busy={pending}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="min-w-20">
          {pageSizes.map((s) => (
            <SelectItem key={s} value={String(s)} className="tabular-nums">
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
