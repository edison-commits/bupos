import { useEffect, useState } from "react";

/**
 * Returns a debounced version of the input value. Prevents typeahead inputs
 * from firing an API request per keystroke — instead the caller keys its
 * fetch effect on the debounced value.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
