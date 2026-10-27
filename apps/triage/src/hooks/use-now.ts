import { useSyncExternalStore } from "react";

const MINUTE = 60_000;

// One shared clock for every relative time on the page. The snapshot is the
// current minute, so a tick that stays within the minute changes nothing and
// React skips the re-render.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  timer ??= setInterval(() => {
    for (const l of listeners) l();
  }, 15_000);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const currentMinute = () => Math.floor(Date.now() / MINUTE) * MINUTE;

// Now, to the minute, kept current. `serverNow` is the time the server
// rendered with: hydration uses it, so the first browser render matches the
// server's HTML, then the live clock takes over.
export function useNow(serverNow: number): number {
  return useSyncExternalStore(subscribe, currentMinute, () => serverNow);
}
