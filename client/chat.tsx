import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { formatResetLabel } from "../shared/format";
import { TOOL_ROW_KIND, ToolRowSchema, toolRow, type ToolRow } from "../shared/chat";

function line(row: ToolRow): string {
  if (row.tool === "list") {
    if (row.state === "running") return "Reading deferred messages…";
    if (row.state === "failed") return "Couldn't read deferred messages";
    return row.items.length === 0 ? "Checked deferred messages · none waiting" : `Checked deferred messages · ${row.items.length} waiting`;
  }
  if (row.state === "running") return "Scheduling a follow-up…";
  if (row.state === "failed") return "Couldn't schedule a follow-up";
  if (row.reset) return row.dueAt === null ? "Scheduled a follow-up for the session reset" : `Scheduled a follow-up for the session reset · ${formatResetLabel(row.dueAt)}`;
  return row.dueAt === null ? "Scheduled a follow-up" : `Scheduled a follow-up for ${formatResetLabel(row.dueAt)}`;
}

function more(row: ToolRow): string | null {
  if (row.state === "failed") return row.error || null;
  if (row.tool === "schedule") return row.text || null;
  if (row.items.length === 0) return null;
  return row.items.map((item) => `${item.dueAt === null ? "at reset" : formatResetLabel(item.dueAt)}  ${item.text}`).join("\n");
}

/**
 * Defer's own agent tools as one quiet line, sized like Paseo's tool rows,
 * instead of a raw `mcp__paseo__defer_schedule_message` call. Press to read
 * the message the agent queued, or the queue it read.
 */
function ToolRowView({ item, theme }: PluginTimelineItemProps<ToolRow>) {
  const c = theme.colors;
  const row = item.data;
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const detail = more(row);
  const openable = detail !== null;
  const open = expanded && openable;
  const active = openable && (hovered || expanded);
  const failed = row.state === "failed";
  const tone = failed ? c.statusDanger : c.foregroundMuted;
  return <View style={{ marginHorizontal: -13 }}>
    <Pressable disabled={!openable} onPress={() => setExpanded((value) => !value)} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      accessibilityRole={openable ? "button" : undefined} aria-expanded={openable ? expanded : undefined} aria-busy={row.state === "running"}
      style={{ flexDirection: "row", alignItems: "center", borderRadius: 8, borderWidth: 1, borderColor: open ? c.border : "transparent", borderBottomLeftRadius: open ? 0 : 8, borderBottomRightRadius: open ? 0 : 8, backgroundColor: open ? c.surface1 : "transparent", paddingHorizontal: 8, paddingVertical: 4 }}>
      <View style={{ width: 22, height: 22, marginRight: 4, alignItems: "center", justifyContent: "center" }}>
        {active
          ? <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}><Icon name="ChevronRight" size={14} color={c.foreground} /></View>
          : <Icon name={failed ? "TriangleAlert" : "Clock"} size={12} color={tone} />}
      </View>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, fontVariant: ["tabular-nums"], color: failed ? c.statusDanger : active || row.state === "running" ? c.foreground : c.foregroundMuted, opacity: row.state === "running" ? 0.72 : 1 }}>{line(row)}</Text>
    </Pressable>
    {open ? <View style={{ borderWidth: 1, borderTopWidth: 0, borderColor: c.border, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, overflow: "hidden" }}>
      <ScrollView style={[{ maxHeight: 240 }, Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as object) : null]} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}>
        <Text selectable style={{ color: failed ? c.statusDanger : c.foreground, fontSize: 13, lineHeight: 19, fontVariant: ["tabular-nums"] }}>{detail}</Text>
      </ScrollView>
    </View> : null}
  </View>;
}

export function contributeChat(client: PluginClientContext) {
  const removers = [
    client.addTimelineTransformer({
      id: "defer-tool-calls",
      query: { itemType: "tool_call" },
      transform({ item }) {
        const row = toolRow(item.name, item.status, item.detail, item.error);
        return row === null ? undefined : { items: [{ type: "plugin" as const, kind: TOOL_ROW_KIND, version: 1, data: row }] };
      },
    }),
    client.addTimelineRenderer({ kind: TOOL_ROW_KIND, version: 1, schema: ToolRowSchema, Component: ToolRowView }),
  ];
  return () => { for (const remove of removers) if (typeof remove === "function") void remove(); };
}
