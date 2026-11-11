import { Dimensions } from "react-native";

/**
 * Whether the app is laid out for a phone, decided exactly as Paseo decides
 * it, so Defer's choice between the pill and the composer control always
 * agrees with where the host would put that control.
 *
 * Paseo 0.16's composer folds every plugin composer item into its overflow
 * sheet (opened from the model button) when `useIsCompactFormFactor()` is
 * true, and never draws a toolbar slot for them then. That hook is the
 * Unistyles breakpoint being `xs` or `sm`, with breakpoints
 * `{ xs: 0, sm: 576, md: 600, ... }`: compact below 600px. On web, Unistyles
 * tracks each breakpoint with `matchMedia("(min-width: <n>px)")`, so the same
 * query here flips in the same frame as the host. On the native app the
 * window width from `Dimensions` stands in for it. The host exposes the same
 * bit to components as `props.layout.compact`, but nothing outside a mounted
 * component, and the pills are registered from the entrypoint.
 */
export const COMPACT_BELOW_PX = 600;

export interface FormFactor {
  compact(): boolean;
  /** Fires only when `compact()` changes value. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

type MediaQuery = {
  matches: boolean;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
  addListener?(listener: () => void): void;
  removeListener?(listener: () => void): void;
};

export interface FormFactorEnvironment {
  matchMedia?: (query: string) => MediaQuery;
  dimensions?: {
    get(dim: "window"): { width: number };
    addEventListener(type: "change", listener: () => void): { remove(): void } | undefined;
  };
}

function defaultEnvironment(): FormFactorEnvironment {
  const media = (globalThis as { matchMedia?: (query: string) => MediaQuery }).matchMedia;
  return {
    matchMedia: typeof media === "function" ? (query) => media.call(globalThis, query) : undefined,
    dimensions: Dimensions as unknown as FormFactorEnvironment["dimensions"],
  };
}

export function createFormFactor(env: FormFactorEnvironment = defaultEnvironment()): FormFactor {
  const listeners = new Set<() => void>();
  let read: () => boolean;
  let detach: () => void = () => undefined;
  let current: boolean;

  const changed = () => {
    const next = read();
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  if (env.matchMedia !== undefined) {
    const query = env.matchMedia(`(min-width: ${COMPACT_BELOW_PX}px)`);
    read = () => !query.matches;
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", changed);
      detach = () => query.removeEventListener?.("change", changed);
    } else if (typeof query.addListener === "function") {
      query.addListener(changed);
      detach = () => query.removeListener?.(changed);
    }
  } else if (env.dimensions !== undefined) {
    const dims = env.dimensions;
    read = () => dims.get("window").width < COMPACT_BELOW_PX;
    const subscription = dims.addEventListener("change", changed);
    detach = () => subscription?.remove();
  } else {
    read = () => false;
  }
  current = read();

  return {
    compact: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispose() {
      detach();
      listeners.clear();
    },
  };
}
