// Whether the desktop sidebar is open, persisted in a cookie so a reload
// keeps it. Shared by the client sidebar (initial state, writes) and the
// inline script that applies it before first paint; kept out of the client
// module so a Server Component can import the values.

export const SIDEBAR_COOKIE_NAME = "sidebar_state";
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const cookiePattern = new RegExp(`(?:^|; )${SIDEBAR_COOKIE_NAME}=(true|false)`);

// undefined on the server or when nothing is saved yet.
export function readSidebarOpen(): boolean | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(cookiePattern);
  return match ? match[1] === "true" : undefined;
}

export function writeSidebarOpen(open: boolean) {
  document.cookie = `${SIDEBAR_COOKIE_NAME}=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
}

// Runs inline right after the sidebar markup, before first paint: if the
// saved state is collapsed, switch the server-rendered (expanded) sidebar to
// collapsed. The provider then hydrates from the same cookie, so React's
// first client render matches these attributes.
export const sidebarStateScript = `(function(){try{var m=document.cookie.match(/(?:^|; )${SIDEBAR_COOKIE_NAME}=(true|false)/);if(!m||m[1]!=="false")return;document.querySelectorAll('[data-slot="sidebar"][data-collapse-to]').forEach(function(el){el.setAttribute("data-state","collapsed");el.setAttribute("data-collapsible",el.getAttribute("data-collapse-to"));});}catch(e){}})();`;
