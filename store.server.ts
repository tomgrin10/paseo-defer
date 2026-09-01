import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DeferredSchema, type Deferred } from "./defer.shared";
import { z } from "zod";

const FileSchema = z.object({ version: z.literal(1), items: z.array(DeferredSchema) });

export function dataDir(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "defer");
}

const filePath = () => join(dataDir(), "queue.json");

/**
 * Single-writer store. The engine tick and RPC handlers share one process, so a
 * promise chain is enough to keep read-modify-write sequences from interleaving.
 */
let tail: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  // Keep the chain alive even when a caller rejects.
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readAll(): Promise<Deferred[]> {
  try {
    const raw = await readFile(filePath(), "utf8");
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.items;
    console.error("[defer] queue file failed validation; starting from empty", parsed.error.message);
    return [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error("[defer] could not read queue file; starting from empty", String(error));
    }
    return [];
  }
}

async function writeAll(items: Deferred[]): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const target = filePath();
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, items }, null, 2), "utf8");
  await rename(temp, target);
}

export const store = {
  list: (): Promise<Deferred[]> => serialize(readAll),

  add: (item: Deferred): Promise<Deferred> =>
    serialize(async () => {
      const items = await readAll();
      items.push(item);
      await writeAll(items);
      return item;
    }),

  /** Applies `patch` to one item and persists. Returns the updated item. */
  update: (id: string, patch: Partial<Deferred>): Promise<Deferred | null> =>
    serialize(async () => {
      const items = await readAll();
      const index = items.findIndex((entry) => entry.id === id);
      if (index === -1) return null;
      const updated = { ...items[index], ...patch } satisfies Deferred;
      items[index] = updated;
      await writeAll(items);
      return updated;
    }),

  /**
   * Applies `patch` only while the item is still waiting. Once the engine has
   * picked an item up, editing it could change the text mid-send or resurrect a
   * settled row, so those are refused instead.
   */
  updatePending: (
    id: string,
    patch: Partial<Deferred>,
  ): Promise<{ item: Deferred | null; reason: "missing" | "settled" | null }> =>
    serialize(async () => {
      const items = await readAll();
      const index = items.findIndex((entry) => entry.id === id);
      if (index === -1) return { item: null, reason: "missing" };
      if (items[index].state !== "pending") return { item: null, reason: "settled" };
      const updated = { ...items[index], ...patch } satisfies Deferred;
      items[index] = updated;
      await writeAll(items);
      return { item: updated, reason: null };
    }),

  removeSettled: (agentId?: string): Promise<number> =>
    serialize(async () => {
      const items = await readAll();
      const keep = items.filter((entry) => {
        const settled = entry.state !== "pending" && entry.state !== "sending";
        const scoped = agentId === undefined || entry.agentId === agentId;
        return !(settled && scoped);
      });
      const removed = items.length - keep.length;
      if (removed > 0) await writeAll(keep);
      return removed;
    }),

  /**
   * Recovers items left mid-send by a crash. Re-sending could duplicate a
   * message into a live session, so these fail closed instead.
   */
  recoverInterrupted: (): Promise<number> =>
    serialize(async () => {
      const items = await readAll();
      let count = 0;
      for (const item of items) {
        if (item.state !== "sending") continue;
        item.state = "failed";
        item.error = "Plugin stopped while sending; not retried to avoid a duplicate message.";
        item.settledAt = new Date().toISOString();
        count += 1;
      }
      if (count > 0) await writeAll(items);
      return count;
    }),
};
