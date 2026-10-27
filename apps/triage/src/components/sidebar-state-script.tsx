import { sidebarStateScript } from "@/lib/sidebar-state";

// Must come right after the sidebar in the document so it runs once that
// markup is parsed but before the browser paints it.
export function SidebarStateScript() {
  return <script dangerouslySetInnerHTML={{ __html: sidebarStateScript }} />;
}
