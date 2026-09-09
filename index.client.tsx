import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DeferPanel } from "./client/panel";
import { contributeClient } from "./client/pill";
import { DeferOverview } from "./client/surface";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addWorkspacePanel({
      id: "defer",
      title: "Defer",
      icon: "Clock",
      context: "agent",
      // A narrow list of waiting messages reads well beside the transcript, so
      // offer it in Explorer as well as a full workspace tab.
      locations: ["workspace", "explorer"],
      Component: DeferPanel,
    }),
    client.addCommandCenterItem({
      id: "defer-message",
      title: "Defer a message",
      icon: "Clock",
      keywords: ["later", "delay", "queue", "schedule", "snooze"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel("defer");
      },
    }),
    client.addCommandCenterItem({
      id: "defer-message-to-session",
      title: "Defer a message to a session",
      icon: "Clock",
      keywords: ["later", "delay", "queue", "schedule", "snooze", "session"],
      context: "global",
      onSelect({ openSurface }) {
        openSurface("overview");
      },
    }),
    client.addSurface("overview", DeferOverview),
    client.addSidebarItem({
      id: "defer-overview",
      title: "Deferred",
      icon: "Clock",
      surface: "overview",
    }),
  ];

  const cleanupPill = contributeClient(client);
  return () => {
    cleanupPill();
    for (const remove of removers) remove();
  };
}
