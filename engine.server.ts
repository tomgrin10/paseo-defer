import { randomUUID } from "node:crypto";
import { store } from "./store.server";
import {
  clearCaches,
  fetchSessionResetsAt,
  readAgentStates,
  withDaemon,
} from "./daemon.server";
import { lifecycle } from "./lifecycle.shared";
import type { Deferred, Trigger } from "./defer.shared";

const TICK_MS = 15_000;

/** Resolves the absolute due instant for a trigger, when one is knowable up front. */
export async function resolveDueAt(
  trigger: Trigger,
  createdAt: string,
): Promise<{ dueAt: string | null; anchorResetsAt: string | null }> {
  if (trigger.kind === "after") {
    return { dueAt: new Date(Date.parse(createdAt) + trigger.ms).toISOString(), anchorResetsAt: null };
  }
  if (trigger.kind === "at") {
    return { dueAt: new Date(trigger.iso).toISOString(), anchorResetsAt: null };
  }
  const anchor = await fetchSessionResetsAt().catch((error: unknown) => {
    console.error("[defer] could not read usage window at create time", String(error));
    return null;
  });
  return { dueAt: anchor, anchorResetsAt: anchor };
}

export function createDeferredRecord(input: {
  agentId: string;
  text: string;
  trigger: Trigger;
  dueAt: string | null;
  anchorResetsAt: string | null;
}): Deferred {
  return {
    id: randomUUID(),
    agentId: input.agentId,
    text: input.text,
    trigger: input.trigger,
    dueAt: input.dueAt,
    anchorResetsAt: input.anchorResetsAt,
    createdAt: new Date().toISOString(),
    state: "pending",
    settledAt: null,
    error: null,
  };
}

function isTimeDue(item: Deferred, now: number): boolean {
  return item.dueAt !== null && Date.parse(item.dueAt) <= now;
}

/**
 * A sessionReset item fires when the reported window end moves, which is the
 * rollover itself. The timestamp comparison only covers being late to notice.
 */
function isResetDue(item: Deferred, currentResetsAt: string | null, now: number): boolean {
  if (item.anchorResetsAt === null) return false;
  if (currentResetsAt !== null && currentResetsAt !== item.anchorResetsAt) return true;
  return Date.parse(item.anchorResetsAt) <= now;
}

async function selectDue(pending: Deferred[], now: number): Promise<Deferred[]> {
  const timed = pending.filter((item) => item.trigger.kind !== "sessionReset");
  const resets = pending.filter((item) => item.trigger.kind === "sessionReset");
  const due = timed.filter((item) => isTimeDue(item, now));
  if (resets.length === 0) return due;

  let currentResetsAt: string | null;
  try {
    // Cached, so this reaches the daemon about once a minute rather than per tick.
    currentResetsAt = await fetchSessionResetsAt();
  } catch (error) {
    console.error("[defer] could not read usage window; reset triggers wait", String(error));
    return due;
  }
  for (const item of resets) {
    if (item.anchorResetsAt === null) {
      if (currentResetsAt === null) continue;
      // Adopt the first window we can read, then wait for it to move.
      await store.update(item.id, { anchorResetsAt: currentResetsAt, dueAt: currentResetsAt });
      continue;
    }
    if (isResetDue(item, currentResetsAt, now)) due.push(item);
  }
  return due;
}

async function deliver(due: Deferred[]): Promise<void> {
  await withDaemon(async (client) => {
    const states = await readAgentStates(client);
    for (const item of due) {
      const state = states.get(item.agentId);
      if (state === undefined || state === "closed") {
        await store.update(item.id, {
          state: "failed",
          error: "The target session is gone.",
          settledAt: new Date().toISOString(),
        });
        console.log(`[defer] ${item.id} failed: target session ${item.agentId} is gone`);
        continue;
      }
      // Sending into a live turn would steer it instead of arriving as its own
      // message, so wait for the session to settle.
      if (state !== "idle") continue;

      // Mark before sending so a crash cannot silently re-send the same text.
      // The claim also returns the freshest row, so an edit that landed after
      // this tick read the queue still wins.
      const claimed = await store.update(item.id, { state: "sending" });
      try {
        await client.sendMessage(item.agentId, claimed?.text ?? item.text);
        await store.update(item.id, {
          state: "sent",
          settledAt: new Date().toISOString(),
          error: null,
        });
        console.log(`[defer] delivered ${item.id} to ${item.agentId}`);
      } catch (error) {
        await store.update(item.id, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          settledAt: new Date().toISOString(),
        });
        console.error(`[defer] failed to deliver ${item.id}`, String(error));
      }
    }
  });
}

async function flush(): Promise<void> {
  const items = await store.list();
  const pending = items.filter((item) => item.state === "pending");
  // No pending work means no daemon connection at all.
  if (pending.length === 0) return;
  const due = await selectDue(pending, Date.now());
  if (due.length === 0) return;
  await deliver(due);
}

/**
 * Starts the scheduler as an import side effect and registers its teardown.
 *
 * `contribute()` cannot call this: Paseo strips `*.server` imports from the
 * client bundle while keeping surrounding statements, so a server identifier in
 * that shared body becomes a ReferenceError that aborts every registration.
 * Teardown still has to run from `contribute()`'s cleanup, or the interval keeps
 * the subprocess alive and Paseo's stop step hangs, which wedges reload. The
 * shared `lifecycle` object bridges the two safely.
 */
function startEngine(): void {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await flush();
    } catch (error) {
      console.error("[defer] tick failed", String(error));
    } finally {
      running = false;
    }
  };

  void store
    .recoverInterrupted()
    .then((count) => {
      if (count > 0) console.error(`[defer] failed ${count} message(s) interrupted by a restart`);
    })
    .catch((error: unknown) => console.error("[defer] recovery failed", String(error)))
    .then(tick);

  const timer = setInterval(() => void tick(), TICK_MS);

  lifecycle.teardown = () => {
    stopped = true;
    clearInterval(timer);
    clearCaches();
  };
}

startEngine();
