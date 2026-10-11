import { displayPreferences } from "./shared/display";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelDeferred,
  clearSettled,
  deleteDeferred,
  createDeferred,
  listDeferred,
  listTimelineDeferred,
  listSessions,
  updateDeferred,
  updateSettings,
} from "./shared/defer";
import { fetchSessionResetsAt, fetchSessions, getProviderByAgentId, withDaemon } from "./server/daemon";
import { createDeferredItem, updateDeferredItem } from "./server/queue";
import { settings } from "./server/settings";
import { dataDir, store } from "./server/store";
import { WorkspaceLabels } from "./server/labels";
import { DeferredTimeline } from "./server/timeline";
import { lifecycle } from "./shared/lifecycle";

export default function contribute(server: PluginServerContext) {
  const labels = new WorkspaceLabels(dataDir(), () => store.list(), withDaemon);
  const timeline = new DeferredTimeline(dataDir(), () => store.list());
  lifecycle.refreshLabels = () => labels.refresh();
  lifecycle.refreshTimeline = () => timeline.refresh();
  const removeStarted = server.on("agent.turn_started", (_, { paseo }) => timeline.use(paseo));
  const removeEnded = server.on("agent.turn_ended", (_, { paseo }) => timeline.use(paseo));
  void labels.refresh();
  server.registerSettings(displayPreferences);
  server.handle(listDeferred, async ({ agentId, usageAgentId }, { paseo }) => {
    void timeline.use(paseo);
    const all = await store.list();
    const items = agentId === undefined ? all : all.filter((item) => item.agentId === agentId);
    let sessionResetsAt: string | null = null;
    let usageError: string | null = null;
    try {
      const providerAgentId = usageAgentId ?? agentId;
      const provider = await getProviderByAgentId(providerAgentId);
      sessionResetsAt = provider === null ? null : await fetchSessionResetsAt(provider);
    } catch (error) {
      usageError = error instanceof Error ? error.message : String(error);
    }
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { items, sessionResetsAt, usageError, settings: await settings.read() };
  });

  server.handle(listTimelineDeferred, async ({ agentId }, { paseo }) => {
    void timeline.use(paseo);
    return { items: (await timeline.visibleItems()).filter(item => item.agentId === agentId) };
  });

  server.handle(updateSettings, async (patch) => ({ settings: await settings.write(patch) }));
  server.handle(listSessions, async () => ({ sessions: await fetchSessions() }));

  server.handle(createDeferred, async (input, { paseo }) => {
    const result = await createDeferredItem(input);
    void labels.refresh();
    await timeline.use(paseo);
    return result;
  });
  server.handle(updateDeferred, async (input, { paseo }) => {
    const result = await updateDeferredItem(input);
    void labels.refresh();
    await timeline.use(paseo);
    return result;
  });

  server.handle(cancelDeferred, async ({ id }, { paseo }) => {
    const { item: updated } = await store.updatePending(id, {
      state: "cancelled",
      settledAt: new Date().toISOString(),
    });
    void labels.refresh();
    await timeline.use(paseo);
    return { ok: updated !== null };
  });

  server.handle(deleteDeferred, async ({ id }, { paseo }) => {
    const ok = await store.removeIdle(id);
    void labels.refresh();
    await timeline.use(paseo);
    return { ok, error: ok ? null : "This message is already being sent and cannot be deleted." };
  });

  server.handle(clearSettled, async ({ agentId }, { paseo }) => {
    const removed = await store.removeSettled(agentId);
    void labels.refresh();
    await timeline.use(paseo);
    return { removed };
  });

  return async () => {
    const teardown = lifecycle.teardown;
    lifecycle.teardown = null;
    lifecycle.refreshLabels = null;
    lifecycle.refreshTimeline = null;
    removeStarted();
    removeEnded();
    await teardown?.();
    await labels.stop();
    await timeline.stop();
  };
}
