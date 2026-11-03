"use client";

import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

// Whether the content scrolls in its own box rather than with the page.
// No box (null) is the page.
export function scrollsItself(box: HTMLElement | null): box is HTMLElement {
  return box !== null && getComputedStyle(box).overflowY !== "visible";
}

// How far the content is from its end, in pixels.
export function distanceFromEnd(box: HTMLElement | null): number {
  if (scrollsItself(box)) return box.scrollHeight - box.scrollTop - box.clientHeight;
  return document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
}

// Scrolls the content to its end. In its own box, `tail` (a composer under
// the box, say) is in the window already, unless the window is too short
// for the box's minimum height; then the page brings it into view.
export function scrollToEnd(box: HTMLElement | null, tail: HTMLElement | null, behavior: ScrollBehavior = "auto") {
  if (scrollsItself(box)) {
    box.scrollTo({ top: box.scrollHeight, behavior });
    tail?.scrollIntoView({ block: "nearest", behavior });
  } else {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  }
}

// Keeps the content at its end while `signal` changes, if the reader was
// there: scrolling up to read stops it, scrolling back down picks it up
// again. Undefined stops following. `mounted` says the content is on
// screen. With no box (a null ref) it follows the page. Returns whether
// the reader is at the end, for a "jump to latest" button.
//
// It scrolls instantly: a smooth scroll's own scroll events, partway
// down, would read as the reader leaving the end.
export function useFollowBottom(
  boxRef: RefObject<HTMLElement | null>,
  tailRef: RefObject<HTMLElement | null>,
  signal: number | undefined,
  mounted: boolean,
): boolean {
  const atEnd = useRef(true);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const box = boxRef.current;
    const onScroll = () => {
      atEnd.current = distanceFromEnd(boxRef.current) < 96;
      setFollowing(atEnd.current);
    };
    onScroll();
    box?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      box?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, [boxRef, mounted]);
  useLayoutEffect(() => {
    if (signal !== undefined && atEnd.current) scrollToEnd(boxRef.current, tailRef.current);
  }, [signal, boxRef, tailRef]);
  return following;
}
