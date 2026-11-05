import { useEffect, useRef, useState } from "react";
import { useApp } from "@/app-context";

/** Runs an async loader and re-runs it when deps change or new data was imported. */
export function useQuery<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; error: Error | null } {
  const { dataVersion } = useApp();
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: Error | null }>({ data: undefined, loading: true, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    loader().then(
      (data) => n === seq.current && setState({ data, loading: false, error: null }),
      (error: Error) => n === seq.current && setState({ data: undefined, loading: false, error }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, dataVersion]);
  return state;
}
