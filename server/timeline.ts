import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { Deferred } from "../shared/defer";
import { DEFER_TIMELINE_KIND, type DeferTimelineData } from "../shared/timeline";

const JournalSchema = z.object({ version: z.literal(1), rows: z.array(z.object({ id: z.string(), agentId: z.string() })) });
type Row = z.infer<typeof JournalSchema>["rows"][number];
type PaseoApi = PluginHandlerContext["paseo"];

/** Stable rows are replaced in place; settled rows become invisible tombstones. */
export class DeferredTimeline {
  private api: PaseoApi | null = null;
  private pending: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  private fingerprints = new Map<string, string>();
  error: string | null = null;

  constructor(private directory: string, private list: () => Promise<Deferred[]>) {}

  use(api: PaseoApi): Promise<void> {
    this.api = api;
    return this.refresh();
  }

  refresh(): Promise<void> {
    if (this.stopped || !this.api) return Promise.resolve();
    this.dirty = true;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      do {
        this.dirty = false;
        try {
          await this.reconcile();
          this.error = null;
        } catch {
          if (!this.stopped && !this.error) console.error("[defer] Deferred timeline updates are awaiting delivery.");
          this.error = "Deferred timeline updates are awaiting delivery.";
        }
      } while (this.dirty && !this.stopped);
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async readJournal(): Promise<Row[]> {
    try {
      return JournalSchema.parse(JSON.parse(await readFile(join(this.directory, "timeline-items.json"), "utf8"))).rows;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeJournal(rows: Row[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "timeline-items.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, rows }));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, path);
      if (process.platform === "linux") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async reconcile(): Promise<void> {
    let rows = await this.readJournal();
    for (const item of await this.list()) {
      if (item.state !== "pending" && item.state !== "sending") continue;
      if (!rows.some(row => row.id === item.id)) {
        rows.push({ id: item.id, agentId: item.agentId });
        // Record ownership before appending, including when an acknowledgement is lost.
        await this.writeJournal(rows);
      }
    }
    let failed = false;
    for (const row of [...rows]) {
      if (this.stopped) return;
      try {
        // Edits and cancellation can land during a slow append. Always use the latest queue.
        const item = (await this.list()).find(item => item.id === row.id);
        const visible = item && (item.state === "pending" || item.state === "sending" || item.state === "failed");
        const data: DeferTimelineData = visible ? {
          id: item.id, text: item.text.length > 2000 ? `${item.text.slice(0, 2000)}…` : item.text,
          trigger: item.trigger, dueAt: item.dueAt, createdAt: item.createdAt, state: item.state as "pending" | "sending" | "failed",
        } : { state: "settled" };
        const fingerprint = JSON.stringify(data);
        if (this.fingerprints.get(row.id) !== fingerprint) {
          await this.api!.agents.ref(row.agentId).timeline.append({
            type: "plugin", id: `deferred:${row.id}`, kind: DEFER_TIMELINE_KIND, version: 1, data,
          });
          this.fingerprints.set(row.id, fingerprint);
          // Reconcile again if an RPC changed the queue while the append was in flight.
          const latest = (await this.list()).find(item => item.id === row.id);
          if (JSON.stringify(latest) !== JSON.stringify(item)) this.dirty = true;
        }
        if (!visible) {
          rows = rows.filter(entry => entry.id !== row.id);
          await this.writeJournal(rows);
          this.fingerprints.delete(row.id);
        }
      } catch {
        // A missing session or one failed append must not block other sessions.
        failed = true;
      }
    }
    if (failed) throw new Error("Timeline reconciliation is incomplete.");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.pending;
    this.api = null;
    this.fingerprints.clear();
  }
}
