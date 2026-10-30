import { useCallback, useEffect, useRef, useState } from "react";

/** Load something when the component appears (or `key` changes); expose loading, error and a reload. */
export function useAsync<T>(load: () => Promise<T>, key: string): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadRef.current().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: unknown) => live && setState({ data: null, error: e instanceof Error ? e.message : "Something went wrong.", loading: false }),
    );
    return () => {
      live = false;
    };
  }, [key, tick]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}
