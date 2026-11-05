import { type PluginAgentPanelProps, useAgent, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { cancelDeferred, clearSettled, listDeferred, updateDeferred, type Deferred } from "../shared/defer";
import { DeferComposer, DeferredRow, deferStyles } from "./composer";
import { Button, Card, errorText, GroupLabel, text, tickFor, useNow } from "./kit";
import { notifyDeferChanged } from "./refresh";
import { useSendNow } from "./send-now";
import { tabular, toneColor } from "./theme";
import { byDueAt, describeActivity, formatClock, queuedLabel, snoozeTrigger } from "../shared/format";

/**
 * The per-session Defer panel, opened from ⌘K "Defer a message" and from a
 * `/defer` line that named no time. The pill's popover covers the same ground
 * in place; this is the roomier version with the session's recent activity.
 */
export function DeferPanel(props: PluginAgentPanelProps) {
  const { theme, layout, workspaceId, navigation } = props;
  const agentId = props.params?.agentId ?? props.agentId;
  const agent = useAgent(agentId, (snapshot) => ({ status: snapshot.status, title: snapshot.title }));
  const workspace = useWorkspace(workspaceId, (snapshot) => ({ name: snapshot.name, title: snapshot.title }));
  const list = useRpc(listDeferred);
  const cancel = useRpc(cancelDeferred);
  const update = useRpc(updateDeferred);
  const clear = useRpc(clearSettled);
  const toast = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["defer", agentId];

  const [editingId, setEditingId] = useState<string | null>(null);

  const queue = useQuery({
    queryKey,
    queryFn: () => list({ agentId }),
    refetchInterval: 10_000,
  });

  const invalidate = () => {
    notifyDeferChanged();
    return queryClient.invalidateQueries({ queryKey });
  };
  const send = useSendNow(invalidate);
  const styles = useMemo(() => deferStyles(theme, layout), [theme, layout]);
  const c = theme.colors;
  const t = text(c);

  const items = queue.data?.items ?? [];
  const pending = byDueAt(items.filter((item) => item.state === "pending" || item.state === "sending"));
  const settled = items.filter((item) => item.state !== "pending" && item.state !== "sending");
  const editing = items.find((item) => item.id === editingId) ?? null;
  const now = useNow(tickFor(pending, Date.now()));

  const sessionTitle = agent?.title?.trim() || "Untitled session";
  const workspaceLabel = workspace?.title?.trim() || workspace?.name?.trim() || "";
  const working = agent?.status === "running" || agent?.status === "initializing";

  function onCancel(item: Deferred) {
    if (editingId === item.id) setEditingId(null);
    void cancel({ id: item.id })
      .then(({ ok }) => {
        toast.show(ok ? "Deferred message cancelled" : "That message was already on its way.");
        return invalidate();
      })
      .catch((error: unknown) => toast.error(errorText(error)));
  }

  function onSnooze(item: Deferred) {
    const trigger = snoozeTrigger(item);
    if (trigger === null) return;
    void update({ id: item.id, trigger })
      .then((result) => {
        if (result.error !== null || result.item === null) throw new Error(result.error ?? "That message is no longer waiting.");
        toast.show(`Moved to ${formatClock(result.item.dueAt)}`);
        return invalidate();
      })
      .catch((error: unknown) => toast.error(errorText(error)));
  }

  // This panel sits in front of the session it writes to, so queueing a message
  // and staying put leaves the user one step from where they were. Go back, and
  // toast the timing the list would have shown. Older hosts expose no
  // navigation, so there the panel simply stays open.
  function onCreated(item: Deferred) {
    toast.show(queuedLabel(item));
    navigation?.openAgent({ agentId });
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.body, { maxWidth: 600, width: "100%" }]}>
      <View style={{ gap: 3 }}>
        <Text accessibilityRole="header" style={t.title} numberOfLines={1}>
          {editing === null ? `Defer to ${sessionTitle}` : "Edit deferred message"}
        </Text>
        <Text style={t.meta} numberOfLines={2}>
          {[workspaceLabel, working ? "Agent is working: messages wait for this turn to end" : "Agent is idle: a due message sends within seconds"]
            .filter((part) => part !== "")
            .join(" · ")}
        </Text>
      </View>

      <DeferComposer
        theme={theme}
        styles={styles}
        agentId={agentId}
        resetsAt={queue.data?.sessionResetsAt ?? null}
        usedPct={queue.data?.sessionUsedPct ?? null}
        usageError={queue.data?.usageError ?? null}
        editing={editing}
        onEditingChange={(item) => setEditingId(item?.id ?? null)}
        onSaved={invalidate}
        onCreated={onCreated}
        acceptComposerDraft
      />

      <View style={{ gap: 8, marginTop: 8 }}>
        {pending.length === 0 ? <Text style={t.meta}>Nothing is waiting for this session.</Text> : <GroupLabel theme={theme} label="Waiting" count={pending.length} />}
        {pending.length === 0 ? null : <Card theme={theme} style={{ paddingHorizontal: layout.compact ? 14 : 16 }}>
        {pending.map((item, index) => (
          <View key={item.id} style={index === 0 ? undefined : { borderTopWidth: 1, borderTopColor: c.border }}>
            <DeferredRow
              styles={styles}
              item={item}
              meta=""
              now={now}
              editing={editingId === item.id}
              onEdit={(target) => setEditingId(target.id)}
              onSendNow={send.sendNow}
              scheduling={send.isPending(item.id)}
              onSnooze={onSnooze}
              onCancel={onCancel}
            />
          </View>
        ))}
        </Card>}
      </View>

      {settled.length > 0 ? (
        <View style={{ gap: 8, marginTop: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <GroupLabel theme={theme} label="Recent activity" />
            <Button
              theme={theme}
              kind="ghost"
              small
              compact={layout.compact}
              title="Clear"
              accessibilityLabel="Clear sent, cancelled and failed messages"
              onPress={() => {
                void clear({ agentId })
                  .then(({ removed }) => {
                    toast.show(removed === 1 ? "Cleared 1 message from activity" : `Cleared ${removed} messages from activity`);
                    return invalidate();
                  })
                  .catch((error: unknown) => toast.error(errorText(error)));
              }}
            />
          </View>
          <Card theme={theme} style={{ paddingHorizontal: layout.compact ? 14 : 16 }}>
          {settled.map((item, index) => {
            const entry = describeActivity(item);
            if (entry === null) return null;
            const at = item.settledAt ?? item.createdAt;
            return (
              <View key={item.id} style={{ flexDirection: "row", gap: 12, paddingVertical: 10, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: c.border }}>
                <Text style={[t.meta, tabular, { width: layout.compact ? 62 : 72 }]}>{formatClock(at)}</Text>
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <Text style={t.meta} numberOfLines={2}>
                    <Text style={{ color: toneColor(c, entry.tone), fontWeight: "600" }}>{entry.verb}</Text>
                    {entry.detail === "" ? "" : ` · ${entry.detail}`}
                  </Text>
                  <Text style={[t.meta, { color: c.foreground }]} numberOfLines={1}>{item.text}</Text>
                </View>
              </View>
            );
          })}
          </Card>
        </View>
      ) : null}
    </ScrollView>
  );
}
