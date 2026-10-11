import { displayPreferences } from "./shared/display";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelDeferred,
  clearSettled,
  createDeferred,
  listDeferred,
  listSessions,
  updateDeferred,
  updateSettings,
} from "./shared/defer";
import { fetchSessionResetsAt, fetchSessions, getProviderByAgentId, withDaemon } from "./server/daemon";
import { createDeferredItem, updateDeferredItem } from "./server/queue";
import { settings } from "./server/settings";
import { dataDir, store } from "./server/store";
import { WorkspaceLabels } from "./server/labels";
import { lifecycle } from "./shared/lifecycle";

export default function contribute(server: PluginServerContext) {
  const labels = new WorkspaceLabels(dataDir(), () => store.list(), withDaemon);
  lifecycle.refreshLabels = () => labels.refresh();
  void labels.refresh();
  server.registerSettings(displayPreferences);
  server.handle(listDeferred, async ({ agentId, usageAgentId }) => {
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

  server.handle(updateSettings, async (patch) => ({ settings: await settings.write(patch) }));
  server.handle(listSessions, async () => ({ sessions: await fetchSessions() }));

  server.handle(createDeferred, async input => {
    const result = await createDeferredItem(input);
    void labels.refresh();
    return result;
  });
  server.handle(updateDeferred, async input => {
    const result = await updateDeferredItem(input);
    void labels.refresh();
    return result;
  });

  server.handle(cancelDeferred, async ({ id }) => {
    const updated = await store.update(id, {
      state: "cancelled",
      settledAt: new Date().toISOString(),
    });
    void labels.refresh();
    return { ok: updated !== null };
  });

  server.handle(clearSettled, async ({ agentId }) => {
    const removed = await store.removeSettled(agentId);
    void labels.refresh();
    return { removed };
  });

  return async () => {
    const teardown = lifecycle.teardown;
    lifecycle.teardown = null;
    lifecycle.refreshLabels = null;
    await teardown?.();
    await labels.stop();
  };
}
