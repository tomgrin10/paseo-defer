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
  /** Waiting messages addressed to the sessions of one workspace. */
  forWorkspace(workspaceId: string): readonly Deferred[];
  publish(items: readonly Deferred[]): void;
  /**
   * Where each session lives, agentId -> workspaceId, from the agent stream the
   * pill entrypoint already follows. Closed sessions included: a message waits
   * for its session whether or not it is open. Never read by waking an agent.
   */
  placeAgents(workspaces: ReadonlyMap<string, string>): void;
}

const NONE: readonly Deferred[] = [];

export function createLiveQueue(): LiveQueue {
  let all: readonly Deferred[] = NONE;
  let byAgent = new Map<string, Deferred[]>();
  let placed: ReadonlyMap<string, string> = new Map();
  let byWorkspace = new Map<string, Deferred[]>();
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
    forWorkspace: (workspaceId) => byWorkspace.get(workspaceId) ?? NONE,
    placeAgents(workspaces) {
      if (sameMap(placed, workspaces)) return;
      placed = new Map(workspaces);
      announce();
    },
    publish(items) {
      all = items.filter((item) => item.state === "pending" || item.state === "sending");
      byAgent = new Map();
      for (const item of all) {
        const list = byAgent.get(item.agentId);
        if (list === undefined) byAgent.set(item.agentId, [item]);
        else list.push(item);
      }
      announce();
    },
  };

  function announce(): void {
    byWorkspace = new Map();
    for (const item of all) {
      const workspaceId = placed.get(item.agentId);
      if (workspaceId === undefined) continue;
      const list = byWorkspace.get(workspaceId);
      if (list === undefined) byWorkspace.set(workspaceId, [item]);
      else list.push(item);
    }
    version += 1;
    for (const listener of [...listeners]) listener();
  }
}

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/** Re-render whenever the queue snapshot changes. */
export function useLiveQueue(live: LiveQueue): number {
  return useSyncExternalStore(live.subscribe, live.version, live.version);
}
