import { withButtonVisibility } from "./client/button-visibility";
import { contributeChat } from "./client/chat";
import { contributeDisplay, OVERVIEW_SCREEN } from "./client/display";
import { contributePinnedTimeline } from "./client/timeline-footer";
import { contributeTimeline } from "./client/timeline";
import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { createLiveQueue } from "./client/live";
import { DeferPanel } from "./client/panel";
import { contributeClient } from "./client/pill";
import { DeferOverview } from "./client/surface";
import { offerComposerDraft, offerDefer } from "./client/handoff";
import { notifyDeferChanged } from "./client/refresh";
import { createDeferred } from "./shared/defer";
import { parseDeferCommand } from "./shared/format";

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  const live = createLiveQueue();
  const openSettings = () => client.openSettings("display");
  const Overview = (props: PluginScreenProps) => <DeferOverview {...props} openSettings={openSettings} />;

  const removers: (() => unknown)[] = [
    contributeTimeline(client),
    contributeChat(client),
    client.addScreen({ id: OVERVIEW_SCREEN, title: "Deferred", Component: Overview }),
    client.addAgentPanel({
      id: "defer",
      title: "Defer",
      icon: "Clock",
      locations: ["workspace", "explorer"],
      Component: DeferPanel,
    }),
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
    }),
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
    }),
    client.addCommandCenterItem({
      id: "defer-message-to-session",
      title: "Defer: all deferred messages",
      icon: "Clock",
      keywords: ["later", "delay", "queue", "schedule", "snooze", "session", "deferred"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: OVERVIEW_SCREEN });
      },
    }),
  ];
  contributePinnedTimeline(client);

  const removeDisplay = contributeDisplay(client, live);
  const removeClient = contributeClient(client, live);
  return () => {
    visibility.dispose();
    removeDisplay();
    for (const remove of removers) if (typeof remove === "function") void remove();
    return removeClient();
  };
}
