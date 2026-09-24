import { useEffect, useState } from 'react';

/**
 * The value, updated only once it has stopped changing for `delayMs` (e.g. while a slider is
 * dragged). `isEqual` lets structurally equal objects count as unchanged.
 */
export function useDebounced<T>(value: T, delayMs: number, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (isEqual(value, settled)) return;
    const timer = setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, settled, delayMs, isEqual]);
  return settled;
}
