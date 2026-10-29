import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { deleteDeferred, listDeferred, type Deferred } from "../shared/defer";
import { DeferComposer, deferStyles } from "./composer";
import { notifyDeferChanged } from "./refresh";
import { useSendNow } from "./send-now";
import { formatClock } from "../shared/format";
import { DEFER_TIMELINE_KIND, DeferTimelineSchema, type DeferTimelineData } from "../shared/timeline";

function deliveryTime(iso: string): string {
  return `${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${formatClock(iso)}`;
}

export function DeferredMessage({ item, theme, layout, agentId }: PluginTimelineItemProps<DeferTimelineData>) {
  const list = useRpc(listDeferred);
  const remove = useRpc(deleteDeferred);
  const [editing, setEditing] = useState<Deferred | null>(null);
  const [usage, setUsage] = useState<{ sessionResetsAt: string | null; usageError: string | null }>({ sessionResetsAt: null, usageError: null });
  const [action, setAction] = useState<"loading" | "deleting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = useSendNow(notifyDeferChanged, setError);
  const data = item.data;
  if (data.state === "settled") return null;
  const messageId = data.id;
  const busy = action !== null || send.isPending(messageId);
  async function edit() {
    setError(null); setAction("loading");
    try {
      const queue = await list({ agentId });
      const current = queue.items.find(entry => entry.id === messageId);
      if (current?.state !== "pending") throw new Error("This message is no longer waiting to be sent.");
      setUsage(queue); setEditing(current);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setAction(null); }
  }
  async function deleteMessage() {
    setError(null); setAction("deleting");
    try {
      const result = await remove({ id: messageId });
      if (!result.ok) throw new Error(result.error ?? "Could not delete this deferred message.");
      setEditing(null); notifyDeferChanged();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setAction(null); }
  }
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
      {editing !== null && data.state === "pending" ? (
        <DeferComposer theme={theme} styles={deferStyles(theme, layout)} agentId={agentId}
          resetsAt={usage.sessionResetsAt} usageError={usage.usageError} editing={editing}
          onEditingChange={setEditing} onSaved={notifyDeferChanged} />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {data.state === "pending" ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Edit deferred message" disabled={busy}
              onPress={() => void edit()} style={{ minHeight: 44, justifyContent: "center", paddingVertical: 10, paddingHorizontal: 12, opacity: busy ? 0.5 : 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{action === "loading" ? "Loading…" : "Edit"}</Text>
            </Pressable>
          ) : null}
          {data.state === "pending" ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Send deferred message now" disabled={busy}
              accessibilityHint="Delivery waits until the session is idle"
              onPress={() => { if (!busy) void send.sendNow({ id: messageId, state: "pending" }); }} style={{ minHeight: 44, justifyContent: "center", paddingVertical: 10, paddingHorizontal: 12, opacity: busy ? 0.5 : 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{send.isPending(messageId) ? "Scheduling…" : "Send now"}</Text>
            </Pressable>
          ) : null}
          {data.state !== "sending" ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Delete deferred message" disabled={busy}
              onPress={() => void deleteMessage()} style={{ minHeight: 44, justifyContent: "center", paddingVertical: 10, paddingHorizontal: 12, opacity: busy ? 0.5 : 1 }}>
              <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{action === "deleting" ? "Deleting…" : "Delete"}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      {error !== null ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}

export function contributeTimeline(client: PluginClientContext) {
  client.addTimelineRenderer({ kind: DEFER_TIMELINE_KIND, version: 1, schema: DeferTimelineSchema, Component: DeferredMessage });
}
