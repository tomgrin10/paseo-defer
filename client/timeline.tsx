import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { formatClock } from "../shared/format";
import { DEFER_TIMELINE_KIND, DeferTimelineSchema, type DeferTimelineData } from "../shared/timeline";

function deliveryTime(iso: string): string {
  return `${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${formatClock(iso)}`;
}

export function DeferredMessage({ item, theme, layout }: PluginTimelineItemProps<DeferTimelineData>) {
  const data = item.data;
  if (data.state === "settled") return null;
  const timing = data.state === "sending" ? "Sending now…"
    : data.state === "failed" ? "Could not send. Open Deferred to review."
    : data.trigger.kind === "sessionReset"
      ? `Waiting for session reset${data.dueAt ? ` · ${deliveryTime(data.dueAt)}` : ""}`
      : `Sends ${data.dueAt ? deliveryTime(data.dueAt) : "when ready"} · when the agent is idle`;
  const color = data.state === "failed" ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <View accessibilityLabel="Deferred message" style={{ gap: 8, padding: layout.compact ? 12 : 16, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="Clock" size={16} color={color} />
        <Text style={{ color, fontSize: 14, fontWeight: "600", flexShrink: 1 }}>Deferred message</Text>
      </View>
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{data.text}</Text>
      <Text style={{ color, fontSize: 13 }}>{timing}</Text>
    </View>
  );
}

export function contributeTimeline(client: PluginClientContext) {
  client.addTimelineRenderer({ kind: DEFER_TIMELINE_KIND, version: 1, schema: DeferTimelineSchema, Component: DeferredMessage });
}
