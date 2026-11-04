import { useSyncExternalStore } from "react";
import type { Deferred } from "../shared/defer";

/**
 * The waiting queue as the pill's poll last read it, for views that sit
 * outside any panel: the pill's icon and the sidebar row. One per plugin
 * installation, so two connected hosts never share a queue.
 */
export interface LiveQueue {
  subscribe(listener: () => void): () => void;
  version(): number;
  /** Pending and sending messages across every session. */
  waiting(): readonly Deferred[];
  forAgent(agentId: string): readonly Deferred[];
  publish(items: readonly Deferred[]): void;
}

const NONE: readonly Deferred[] = [];

export function createLiveQueue(): LiveQueue {
  let all: readonly Deferred[] = NONE;
  let byAgent = new Map<string, Deferred[]>();
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    version: () => version,
    waiting: () => all,
    forAgent: (agentId) => byAgent.get(agentId) ?? NONE,
    publish(items) {
      all = items.filter((item) => item.state === "pending" || item.state === "sending");
      byAgent = new Map();
      for (const item of all) {
        const list = byAgent.get(item.agentId);
        if (list === undefined) byAgent.set(item.agentId, [item]);
        else list.push(item);
      }
      version += 1;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Re-render whenever the queue snapshot changes. */
export function useLiveQueue(live: LiveQueue): number {
  return useSyncExternalStore(live.subscribe, live.version, live.version);
}
