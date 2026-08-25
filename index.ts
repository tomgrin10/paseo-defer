import type { PluginContext } from "@getpaseo/plugin";
import {
  cancelDeferred,
  clearSettled,
  createDeferred,
  listDeferred,
  listSessions,
  updateDeferred,
  type Deferred,
} from "./defer.shared";
import { DeferPanel } from "./panel.client";
import { DeferOverview } from "./surface.client";
import { createDeferredRecord, resolveDueAt } from "./engine.server";
import { fetchSessionResetsAt, fetchSessions } from "./daemon.server";
import { store } from "./store.server";
import { lifecycle } from "./lifecycle.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(listDeferred, async ({ agentId }) => {
    const all = await store.list();
    const items = agentId === undefined ? all : all.filter((item) => item.agentId === agentId);
    let sessionResetsAt: string | null = null;
    let usageError: string | null = null;
    try {
      sessionResetsAt = await fetchSessionResetsAt();
    } catch (error) {
      usageError = error instanceof Error ? error.message : String(error);
    }
    // Newest first, so the freshest entry is the one in view.
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { items, sessionResetsAt, usageError };
  });

  plugin.handle(listSessions, async () => ({ sessions: await fetchSessions() }));

  plugin.handle(createDeferred, async ({ agentId, text, trigger }) => {
    const createdAt = new Date().toISOString();
    const { dueAt, anchorResetsAt } = await resolveDueAt(trigger, createdAt);
    const item = await store.add(createDeferredRecord({ agentId, text, trigger, dueAt, anchorResetsAt }));
    console.log(`[defer] queued ${item.id} for ${agentId} (${trigger.kind})`);
    return { item };
  });

  plugin.handle(updateDeferred, async ({ id, text, trigger }) => {
    const patch: Partial<Deferred> = {};
    if (text !== undefined) patch.text = text;
    if (trigger !== undefined) {
      // A changed trigger is re-anchored from now, so "in 15m" means 15m from
      // the edit rather than from the original queueing.
      const editedAt = new Date().toISOString();
      const { dueAt, anchorResetsAt } = await resolveDueAt(trigger, editedAt);
      patch.trigger = trigger;
      patch.dueAt = dueAt;
      patch.anchorResetsAt = anchorResetsAt;
    }
    const { item, reason } = await store.updatePending(id, patch);
    if (reason === "missing") return { item: null, error: "That message is no longer queued." };
    if (reason === "settled") {
      return { item: null, error: "That message is already on its way; it can no longer be edited." };
    }
    console.log(`[defer] edited ${id}`);
    return { item, error: null };
  });

  plugin.handle(cancelDeferred, async ({ id }) => {
    const updated = await store.update(id, {
      state: "cancelled",
      settledAt: new Date().toISOString(),
    });
    return { ok: updated !== null };
  });

  plugin.handle(clearSettled, async ({ agentId }) => ({
    removed: await store.removeSettled(agentId),
  }));

  plugin.addWorkspacePanel({
    id: "defer",
    title: "Defer",
    icon: "Clock",
    context: "agent",
    Component: DeferPanel,
  });

  plugin.addCommandCenterItem({
    id: "defer-message",
    title: "Defer a message",
    icon: "Clock",
    keywords: ["later", "delay", "queue", "schedule", "snooze"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("defer");
    },
  });

  // Paseo hides agent-context items unless the focused tab is a live session, so
  // a brand-new (still draft) tab has no Defer entry at all. This one always
  // resolves, and its surface picks the target session explicitly.
  plugin.addCommandCenterItem({
    id: "defer-message-to-session",
    title: "Defer a message to a session",
    icon: "Clock",
    keywords: ["later", "delay", "queue", "schedule", "snooze", "session"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("overview");
    },
  });

  plugin.addSurface("overview", DeferOverview);
  plugin.addSidebarItem({
    id: "defer-overview",
    title: "Deferred",
    icon: "Clock",
    surface: "overview",
  });

  // Releases the scheduler through a shared object rather than by naming
  // engine.server: Paseo strips server imports from the client bundle but keeps
  // the surrounding code, so a server identifier here would break every
  // contribution. Skipping this stops Paseo's teardown from ever completing.
  return async () => {
    const teardown = lifecycle.teardown;
    lifecycle.teardown = null;
    await teardown?.();
  };
}
