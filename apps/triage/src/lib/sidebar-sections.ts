// Which sidebar groups are collapsed, kept in a cookie so the server renders
// them that way: no flash of the wrong state on load, and React's first
// render matches the HTML. Shared by the server (reads) and the client
// (writes on toggle); no server-only imports, so both can use it.

export const SIDEBAR_SECTIONS_COOKIE = "sidebar_sections_collapsed";
const MAX_AGE = 60 * 60 * 24 * 365;

export type SidebarSection = "recent";
const sections: SidebarSection[] = ["recent"];

// "recent" -> the collapsed sections; unknown names (like the old
// "attention" group) are ignored.
export function parseCollapsedSections(value: string | undefined): SidebarSection[] {
  const names = (value ?? "").split(",");
  return sections.filter((s) => names.includes(s));
}

export function writeSectionOpen(section: SidebarSection, open: boolean) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${SIDEBAR_SECTIONS_COOKIE}=([^;]*)`));
  const collapsed = new Set(parseCollapsedSections(match ? decodeURIComponent(match[1]) : undefined));
  if (open) collapsed.delete(section);
  else collapsed.add(section);
  const value = encodeURIComponent([...collapsed].join(","));
  document.cookie = `${SIDEBAR_SECTIONS_COOKIE}=${value}; path=/; max-age=${MAX_AGE}; samesite=lax`;
}
