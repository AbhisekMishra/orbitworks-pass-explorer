/** Shallow equality for the tuples store subscriptions select (same length, same items by identity). */
export const sameItems = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
