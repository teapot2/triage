import { useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

// ⌘ on a Mac, Ctrl elsewhere (the convention on Windows and Linux). The
// server can't tell, so it renders Ctrl and a Mac switches after hydration.
export function useIsMac() {
  return useSyncExternalStore(
    subscribeNever,
    () => /mac|iphone|ipad/i.test(navigator.userAgent),
    () => false,
  );
}

// The shortcut's modifier as the app writes it: "⌘K", "Ctrl K".
export const modKey = (isMac: boolean) => (isMac ? "⌘" : "Ctrl ");
