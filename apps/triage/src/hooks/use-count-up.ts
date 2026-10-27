import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const reducedMotion = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(reducedMotion);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(reducedMotion).matches,
    () => false,
  );
}

// Strong ease-out, close to the CSS curve the confidence bar fills on.
const easeOut = (p: number) => 1 - (1 - p) ** 4;

// A number that runs to `value` instead of jumping: from 0 on mount with
// `fromZero` (to match something filling in beside it), else only when it
// changes. Unrounded; format it for display. Reduced motion shows `value`.
export function useCountUp(value: number, { duration = 600, fromZero = false } = {}): number {
  const [shown, setShown] = useState(fromZero ? 0 : value);
  const current = useRef(shown);
  const reduce = usePrefersReducedMotion();

  useEffect(() => {
    if (reduce) return;
    const from = current.current;
    if (from === value) return;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      // A frame's timestamp can predate `start` slightly; clamp so the
      // first frame never overshoots below `from`.
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      current.current = from + (value - from) * easeOut(p);
      setShown(current.current);
      if (p < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, duration, reduce]);

  return reduce ? value : shown;
}
