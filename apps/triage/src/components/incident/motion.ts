// Open/close motion for any CollapsibleContent (keyframes in globals.css).
// overflow-hidden clips the content while its height animates; padding must
// live on an inner element so the height can reach 0.
export const collapseMotion =
  "overflow-hidden data-[state=open]:animate-disclosure-down data-[state=closed]:animate-disclosure-up motion-reduce:animate-none";
