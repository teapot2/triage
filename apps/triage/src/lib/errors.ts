// What was thrown, as text: an Error's message, anything else stringified.
// Safe to import in the browser.
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
