// A count with its noun: "1 span", "3 spans". `many` for nouns that don't
// just take an s ("1 query", "2 queries"). Safe on the server and in the
// browser.
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
