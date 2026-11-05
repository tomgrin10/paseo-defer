import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { cancelDeferred, createDeferred, deleteDeferred, listDeferred, updateDeferred, type Deferred } from "../shared/defer";
import { DeferComposer, deferStyles } from "./composer";
import { errorText, rowActions, tickFor, TimerGlyph, useNow } from "./kit";
import { raised, withAlpha } from "./theme";
import { notifyDeferChanged } from "./refresh";
import { useSendNow } from "./send-now";
import { describeWhen, formatClock, snoozeTrigger } from "../shared/format";
import { DEFER_TIMELINE_KIND, DeferTimelineSchema, type DeferTimelineData } from "../shared/timeline";

/** The fields a timeline row carries, filled out into a queue record for the shared formatters. */
function asItem(data: Exclude<DeferTimelineData, { state: "settled" }>, agentId: string): Deferred {
  return {
    id: data.id, agentId, text: data.text, trigger: data.trigger, dueAt: data.dueAt, createdAt: data.createdAt,
    anchorResetsAt: data.trigger.kind === "sessionReset" ? data.dueAt : null,
    state: data.state, settledAt: null, error: data.error ?? null,
  };
}

/**
 * A queued message in its session's chat: the message as it will be sent,
 * under the time it goes out and a live countdown, with +10m, Send now, Edit
 * and Cancel. Drawn on the right, where the message itself will land, and
 * outlined rather than filled because it has not been sent yet. The row is
 * replaced in place as the message changes, and disappears once it is sent or
 * cancelled; a failed send stays until dismissed.
 */
export function DeferredMessage({ item, theme, layout, agentId }: PluginTimelineItemProps<DeferTimelineData>) {
  const list = useRpc(listDeferred);
  const remove = useRpc(deleteDeferred);
  const cancel = useRpc(cancelDeferred);
  const update = useRpc(updateDeferred);
  const create = useRpc(createDeferred);
  const toast = useToast();
  const [editing, setEditing] = useState<Deferred | null>(null);
  const [usage, setUsage] = useState<{ sessionResetsAt: string | null; sessionUsedPct?: number | null | undefined; usageError: string | null }>({ sessionResetsAt: null, usageError: null });
  const [action, setAction] = useState<"loading" | "deleting" | "cancelling" | "snoozing" | "resending" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = useSendNow(notifyDeferChanged, setError);
  const data = item.data;
  const live = data.state === "settled" ? null : asItem(data, agentId);
  const now = useNow(live === null ? 60_000 : tickFor([live], Date.now()));
  if (data.state === "settled" || live === null) return null;
  const messageId = data.id;
  const busy = action !== null || send.isPending(messageId);
  const c = theme.colors;
  const compact = layout.compact;

  async function run(kind: NonNullable<typeof action>, work: () => Promise<void>) {
    setError(null); setAction(kind);
    try { await work(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setAction(null); }
  }
  // Edits go through the full queue record: the row's own text is a preview
  // capped at 2,000 characters.
  const edit = () => run("loading", async () => {
    const queue = await list({ agentId });
    const current = queue.items.find(entry => entry.id === messageId);
    if (current?.state !== "pending") throw new Error("This message is no longer waiting to be sent.");
    setUsage(queue); setEditing(current);
  });
  const deleteMessage = () => run("deleting", async () => {
    const result = await remove({ id: messageId });
    if (!result.ok) throw new Error(result.error ?? "Could not delete this deferred message.");
    setEditing(null); notifyDeferChanged();
  });
  const cancelMessage = () => run("cancelling", async () => {
    const result = await cancel({ id: messageId });
    if (!result.ok) throw new Error("This message is already being sent and cannot be cancelled.");
    setEditing(null); notifyDeferChanged();
  });
  // A failed send is not retried on its own (it may have reached the agent);
  // "Send again" is the user's call. It queues a fresh copy of the full text
  // for now, still idle-gated, and clears the failed row.
  const resend = () => run("resending", async () => {
    const queue = await list({ agentId });
    const current = queue.items.find(entry => entry.id === messageId);
    if (current === undefined) throw new Error("This message is no longer in the queue.");
    await create({ agentId, text: current.text, trigger: { kind: "at", iso: new Date().toISOString() } });
    await remove({ id: messageId });
    toast.show("Sending again when the session is idle");
    notifyDeferChanged();
  });
  const snooze = () => run("snoozing", async () => {
    const trigger = snoozeTrigger(live);
    if (trigger === null) return;
    const result = await update({ id: messageId, trigger });
    if (result.item === null || result.error !== null) throw new Error(result.error ?? "This message is no longer waiting to be sent.");
    toast.show(`Moved to ${formatClock(result.item.dueAt)}`);
    notifyDeferChanged();
  });

  const when = describeWhen(live, now);
  const failed = data.state === "failed";
  const pending = data.state === "pending";
  const canSnooze = pending && data.trigger.kind !== "sessionReset" && data.dueAt !== null;

  return (
    <View style={{ alignItems: compact ? "stretch" : "flex-end", marginVertical: 4 }}>
      <View
        accessibilityLabel="Deferred message"
        style={[
          {
            width: "100%", maxWidth: compact ? undefined : 560, gap: 8,
            paddingTop: 11, paddingHorizontal: 14, paddingBottom: editing === null && (pending || failed) ? 10 : 13,
            borderRadius: 12, backgroundColor: c.surface1,
          },
          failed ? { borderWidth: 1, borderColor: withAlpha(c.statusDanger, 0.6) } : raised(c),
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {failed ? <Icon name="TriangleAlert" size={15} color={c.statusDanger} /> : <TimerGlyph item={live} now={now} size={15} color={when.phase === "waiting" ? c.foreground : c.foregroundMuted} />}
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: 8 }}>
            <Text style={{ color: failed ? c.statusDanger : c.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
              {failed ? "Not sent" : when.time}
            </Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"], flexShrink: 1 }}>
              {failed ? (data.error ?? "The send failed.") : when.detail}
            </Text>
          </View>
        </View>

        {editing !== null && pending ? (
          <DeferComposer theme={theme} styles={deferStyles(theme, layout)} agentId={agentId}
            resetsAt={usage.sessionResetsAt} usedPct={usage.sessionUsedPct ?? null} usageError={usage.usageError} editing={editing}
            onEditingChange={setEditing} onSaved={notifyDeferChanged} />
        ) : (
          <Text selectable numberOfLines={12} style={{ color: c.foreground, fontSize: 14, lineHeight: 21 }}>{data.text}</Text>
        )}

        {editing === null && pending ? rowActions({
          theme, compact, disabled: busy,
          snooze: canSnooze ? { label: "Snooze deferred message by 10 minutes", onPress: () => void snooze() } : undefined,
          send: {
            label: "Send deferred message now", title: send.isPending(messageId) ? "Scheduling…" : "Send now",
            hint: "Delivery waits until the session is idle",
            onPress: () => { if (!busy) void send.sendNow({ id: messageId, state: "pending" }); },
          },
          edit: { label: "Edit deferred message", title: action === "loading" ? "Loading…" : "Edit", onPress: () => void edit() },
          end: { label: "Cancel deferred message", title: action === "cancelling" ? "Cancelling…" : "Cancel", onPress: () => void cancelMessage() },
        }) : null}
        {failed ? rowActions({
          theme, compact, disabled: busy,
          resend: { label: "Send deferred message again", title: action === "resending" ? "Sending…" : "Send again", onPress: () => void resend() },
          end: { label: "Delete deferred message", title: action === "deleting" ? "Dismissing…" : "Dismiss", onPress: () => void deleteMessage() },
        }) : null}
        {error !== null ? <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 18 }}>{error}</Text> : null}
      </View>
    </View>
  );
}

export function contributeTimeline(client: PluginClientContext) {
  return client.addTimelineRenderer({ kind: DEFER_TIMELINE_KIND, version: 1, schema: DeferTimelineSchema, Component: DeferredMessage });
}
