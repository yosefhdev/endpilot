import { useEffect, useState } from "react";

/** A size in px remembered across sessions (per-user convenience; falls back to `initial`). */
export function useStoredSize(key: string, initial: number) {
  const [size, setSize] = useState(() => {
    try {
      const n = Number(localStorage.getItem(key));
      return n > 0 ? n : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(Math.round(size)));
    } catch {
      // Storage unavailable: the size just won't be remembered.
    }
  }, [key, size]);
  return [size, setSize] as const;
}
