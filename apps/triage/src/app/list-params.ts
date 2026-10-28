import { defaultSort, type IncidentSort, parseSort } from "@/lib/investigation/sort";

// The incident list's state, in the URL (?q=&status=&severity=&service=
// &sort=&size=&page=) so a reload or a shared link shows the same rows. The
// list, its toolbar (search, Filter, Sort), its page size and its page links
// all read and write it through here. The page size is also a preference,
// kept in a cookie for when the URL doesn't name one, so the sidebar's plain
// link to the list opens it at your size. Shared by the server (reads) and
// the client (writes); no server-only imports.

// How many incidents a page can show; the first is the default.
export const pageSizes = [10, 25, 50] as const;
export type PageSize = (typeof pageSizes)[number];
export const defaultPageSize: PageSize = pageSizes[0];

export const PAGE_SIZE_COOKIE = "incidents_page_size";
const MAX_AGE = 60 * 60 * 24 * 365;

// The facets the list filters by, each kept under its own URL key as a
// comma-separated list (?status=failed,diagnosed).
export const incidentFacetIds = ["status", "severity", "service"] as const;
export type IncidentFacet = (typeof incidentFacetIds)[number];
export type IncidentFilters = Record<IncidentFacet, string[]>;

export type ListParams = {
  q: string;
  filters: IncidentFilters;
  sort: IncidentSort;
  size: PageSize;
  page: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const pageSize = (value: string | undefined) => pageSizes.find((s) => String(s) === value);

// The list's state from its URL, then the saved page size, then the
// defaults. The page is as asked; clampPage fits it to the matching rows.
export function parseListParams(params: SearchParams, savedSize?: string): ListParams {
  const n = Number(single(params.page));
  return {
    q: single(params.q)?.trim() ?? "",
    filters: Object.fromEntries(
      incidentFacetIds.map((f) => [f, single(params[f])?.split(",").filter(Boolean) ?? []]),
    ) as IncidentFilters,
    sort: parseSort(single(params.sort)),
    size: pageSize(single(params.size)) ?? pageSize(savedSize) ?? defaultPageSize,
    page: Number.isInteger(n) && n >= 1 ? n : 1,
  };
}

// The pages `total` rows make, and the asked-for page within them.
export function clampPage(params: ListParams, total: number): { page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(total / params.size));
  return { page: Math.min(params.page, pageCount), pageCount };
}

export const isFiltering = ({ q, filters }: ListParams) =>
  q !== "" || incidentFacetIds.some((f) => filters[f].length > 0);

export function savePageSize(size: PageSize) {
  document.cookie = `${PAGE_SIZE_COOKIE}=${size}; path=/; max-age=${MAX_AGE}; samesite=lax`;
}

// The list's URL for a state, leaving out whatever is the default. Past the
// first page the size is always named: a page number means nothing without
// it, and someone opening the link may have saved another size.
export function listHref({ q, filters, sort, size, page }: ListParams): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  for (const f of incidentFacetIds) if (filters[f].length > 0) params.set(f, filters[f].join(","));
  if (sort !== defaultSort) params.set("sort", sort);
  if (size !== defaultPageSize || page > 1) params.set("size", String(size));
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}
