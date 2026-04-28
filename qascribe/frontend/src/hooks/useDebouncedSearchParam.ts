import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export function parseList<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T[] {
  if (!raw) return [];
  const set = new Set<string>(allowed);
  const seen = new Set<T>();
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (set.has(t)) seen.add(t as T);
  }
  return Array.from(seen);
}

/**
 * Hook bundle for list-page URL state:
 *   - patchParams({ key: value | null }) — set/delete params, replace history
 *   - clearAll() — wipe all params
 *   - debouncedQ — current debounced query value mirrored from `?q=`
 *   - inputValue / setInputValue — controlled input that pushes to URL after debounceMs
 */
export function useListPageUrlState(debounceMs = 200) {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';

  function patchParams(updates: Record<string, string | null>) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(updates)) {
          if (v == null || v === '') next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  }

  function clearAll() {
    setSearchParams(new URLSearchParams(), { replace: true });
  }

  const [inputValue, setInputValue] = useState(q);
  useEffect(() => {
    setInputValue(q);
  }, [q]);
  useEffect(() => {
    if (inputValue === q) return;
    const t = setTimeout(() => {
      patchParams({ q: inputValue || null, page: null });
    }, debounceMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue]);

  return {
    searchParams,
    q,
    inputValue,
    setInputValue,
    patchParams,
    clearAll,
  };
}
