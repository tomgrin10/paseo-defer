import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Deferred } from "../shared/defer";
import type { DaemonClient } from "./daemon";

export const DEFERRED_WORKSPACE_LABEL = { name: "Deferred", color: "blue" as const };
type Connect = <T>(work: (client: DaemonClient) => Promise<T>) => Promise<T>;

/** Label delivery runs separately from queue changes and message delivery. */
export class WorkspaceLabels {
  private pending: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  private clients = new Set<DaemonClient>();
  error: string | null = null;

  constructor(
    private directory: string,
    private list: () => Promise<Deferred[]>,
    private connect: Connect,
  ) {}

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        do {
          this.dirty = false;
          await this.reconcile();
        } while (this.dirty && !this.stopped);
        this.error = null;
      } catch {
        if (this.stopped) return;
        const message = "Workspace labels are awaiting delivery; queued messages are unchanged.";
        if (!this.error) console.error(`[defer] ${message}`);
        this.error = message;
      }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async withClient(work: (client: DaemonClient) => Promise<void>): Promise<void> {
    await this.connect(async client => {
      if (this.stopped) return;
      this.clients.add(client);
      try { await work(client); }
      finally { this.clients.delete(client); }
    });
  }

  private async readManaged(): Promise<string[]> {
    try {
      const state: unknown = JSON.parse(await readFile(join(this.directory, "workspace-labels.json"), "utf8"));
      const journal = state as { version?: unknown; workspaceIds?: unknown } | null;
      if (journal?.version !== 1 || !Array.isArray(journal.workspaceIds) ||
        !journal.workspaceIds.every(id => typeof id === "string" && id.length > 0)) {
        throw new Error("Invalid workspace label journal.");
      }
      return [...new Set(journal.workspaceIds as string[])];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeManaged(workspaceIds: string[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "workspace-labels.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, workspaceIds }));
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
    let managed = await this.readManaged();
    const items = await this.list();
    const waiting = (item: Deferred) => item.state === "pending" || item.state === "sending";
    const agents = [...new Set(items.filter(waiting).map(item => item.agentId))];
    if (!agents.length && !managed.length) return;
    const workspaces = new Map<string, string>();
    if (agents.length) await this.withClient(async client => {
      if (!client.fetchAgent) throw new Error("Agent workspace lookup is unavailable.");
      for (const agentId of agents) {
        if (this.stopped) return;
        const agent = (await client.fetchAgent(agentId))?.agent;
        if (agent?.workspaceId) workspaces.set(agentId, agent.workspaceId);
      }
    });
    const acknowledged = new Set<string>();
    for (let i = 0; i < 400 && !this.stopped; i++) {
      // Re-read after each acknowledgement so cancellation during a slow RPC
      // removes the label again, while another waiting session keeps it.
      const desired = new Set((await this.list()).filter(waiting)
        .map(item => workspaces.get(item.agentId)).filter((id): id is string => !!id));
      const remove = managed.find(id => !desired.has(id));
      const add = [...desired].find(id => !managed.includes(id)) ?? [...desired].find(id => !acknowledged.has(id));
      const workspaceId = remove ?? add;
      if (!workspaceId) return;
      const assigned = remove === undefined;
      if (assigned && !managed.includes(workspaceId)) {
        managed = [...managed, workspaceId];
        // Persist ownership before assignment: a lost acknowledgement or crash
        // must not leave a label that Defer later forgets to remove.
        await this.writeManaged(managed);
      }
      await this.withClient(async client => {
        if (!client.setWorkspaceLabel) throw new Error("Workspace labels are unavailable.");
        await client.setWorkspaceLabel({ workspaceId, label: DEFERRED_WORKSPACE_LABEL, assigned });
      });
      if (this.stopped) return; // Cleanup may have closed or skipped the RPC; retain ownership for restart.
      if (assigned) acknowledged.add(workspaceId);
      else {
        managed = managed.filter(id => id !== workspaceId);
        await this.writeManaged(managed);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.clients].map(client => client.close().catch(() => undefined)));
    await this.pending;
  }
}
