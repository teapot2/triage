import { useState } from "react";

// True from the first render where `value` differs from what it was on
// mount, and from then on. Lets a change made in view animate while the
// same state on page load just shows. Set during render, React's pattern
// for state derived from a changed value.
export function useChangedSinceMount<T>(value: T): boolean {
  const [initial] = useState(value);
  const [changed, setChanged] = useState(false);
  if (!changed && !Object.is(value, initial)) setChanged(true);
  return changed;
}
