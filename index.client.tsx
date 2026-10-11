import { contributeDisplay } from "./client/display";
import { contributePinnedTimeline } from "./client/timeline-footer";
import { contributeTimeline } from "./client/timeline";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DeferPanel } from "./client/panel";
import { contributeClient } from "./client/pill";
import { DeferOverview } from "./client/surface";
import { offerComposerDraft, offerDefer } from "./client/handoff";
import { notifyDeferChanged } from "./client/refresh";
import { createDeferred } from "./shared/defer";
import { parseDeferCommand } from "./shared/format";

export default function contribute(client: PluginClientContext) {
  contributeTimeline(client);
  contributePinnedTimeline(client);
  client.addWorkspacePanel({
    id: "defer",
    title: "Defer",
    icon: "Clock",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: DeferPanel,
  });

  client.addCommandCenterItem({
    id: "defer-message",
    title: "Defer a message",
    icon: "Clock",
    keywords: ["later", "delay", "queue", "schedule", "snooze"],
    context: "agent",
    onSelect({ agent, openPanel }) {
      offerComposerDraft(agent.id);
      openPanel("defer");
    },
  });

  client.addSlashCommand({
    name: "defer",
    description: "Send this message later",
    argumentHint: "2h ship the release notes",
    context: "agent",
    async onSubmit({ agent, args, rpc, openPanel }) {
      const { trigger, text } = parseDeferCommand(args);
      const body = text.trim();
      if (trigger === null || body === "") {
        offerDefer(agent.id, { text: body, trigger });
        openPanel("defer");
        return;
      }
      await rpc(createDeferred, { agentId: agent.id, text: body, trigger });
      notifyDeferChanged();
    },
  });

  client.addCommandCenterItem({
    id: "defer-message-to-session",
    title: "Defer: deferred messages and sessions",
    icon: "Clock",
    keywords: ["later", "delay", "queue", "schedule", "snooze", "session"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("overview");
    },
  });

  client.addSurface("overview", DeferOverview);
  const removeDisplay = contributeDisplay(client, {
    id: "defer-overview",
    title: "Deferred",
    icon: "Clock",
    surface: "overview",
  });

  const removeClient = contributeClient(client);
  return () => { removeDisplay(); return removeClient(); };
}
