import {
  Icon,
  type PluginAgentPanelProps,
  useAgent,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  cancelDeferred,
  clearSettled,
  listDeferred,
  DEFAULT_SETTINGS,
  type Deferred,
} from "./defer.shared";
import { DeferComposer, DeferredRow, PillSetting, deferStyles } from "./composer.client";
import { notifyDeferChanged } from "./refresh.client";
import { queuedLabel, stateLabel, stateTone } from "./format.shared";

export function DeferPanel({
  theme,
  layout,
  agentId,
  workspaceId,
  navigation,
}: PluginAgentPanelProps) {
  const agent = useAgent(agentId, (snapshot) => ({
    status: snapshot.status,
    title: snapshot.title,
    provider: snapshot.provider,
  }));
  const workspace = useWorkspace(workspaceId, (snapshot) => ({
    name: snapshot.name,
    title: snapshot.title,
  }));
  const list = useRpc(listDeferred);
  const cancel = useRpc(cancelDeferred);
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
  const styles = useMemo(() => deferStyles(theme, layout), [theme, layout]);

  const items = queue.data?.items ?? [];
  const pending = items.filter((item) => item.state === "pending" || item.state === "sending");
  const settled = items.filter((item) => item.state !== "pending" && item.state !== "sending");
  const editing = items.find((item) => item.id === editingId) ?? null;

  const sessionTitle = agent?.title?.trim() ?? "";
  const workspaceLabel = workspace?.title?.trim() || workspace?.name?.trim() || "";
  const sessionMeta = [workspaceLabel, agent?.provider ?? "", agent?.status ?? ""]
    .filter((part) => part !== "")
    .join(" · ");

  function onCancel(item: Deferred) {
    if (editingId === item.id) setEditingId(null);
    void cancel({ id: item.id })
      .then(() => {
        toast.show("Deferred message cancelled");
        return invalidate();
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <View style={styles.row}>
        <Icon name="Clock" size={16} color={theme.colors.foregroundMuted} />
        <Text style={styles.heading}>
          {editing === null ? "Defer a message" : "Edit deferred message"}
        </Text>
      </View>

      <View style={styles.target}>
        <Text style={styles.targetTitle} numberOfLines={1}>
          {sessionTitle === "" ? "Untitled session" : sessionTitle}
        </Text>
        <Text style={styles.targetMeta} numberOfLines={1}>
          {sessionMeta}
        </Text>
        <Text style={styles.targetMeta} numberOfLines={1} selectable>
          {agentId}
        </Text>
      </View>

      <Text style={styles.hint}>
        {agent?.status === "idle"
          ? "This session is idle, so a due message is delivered on the next check."
          : "Delivery waits until this session finishes its current turn."}
      </Text>

      <DeferComposer
        theme={theme}
        styles={styles}
        agentId={agentId}
        resetsAt={queue.data?.sessionResetsAt ?? null}
        usageError={queue.data?.usageError ?? null}
        editing={editing}
        onEditingChange={(item) => setEditingId(item?.id ?? null)}
        onSaved={invalidate}
        onCreated={onCreated}
      />

      <Text style={styles.heading}>{`Deferred for this session (${pending.length})`}</Text>
      {pending.length === 0 ? <Text style={styles.hint}>Nothing waiting for this session.</Text> : null}
      {pending.map((item) => (
        <DeferredRow
          key={item.id}
          styles={styles}
          item={item}
          meta={stateLabel(item)}
          editing={editingId === item.id}
          onEdit={(target) => setEditingId(target.id)}
          onCancel={onCancel}
        />
      ))}

      {settled.length > 0 ? (
        <>
          <View style={styles.row}>
            <Text style={styles.heading}>{`History (${settled.length})`}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear delivered and failed messages"
              onPress={() => {
                void clear({ agentId })
                  .then(({ removed }) => {
                    toast.show(`Cleared ${removed} message(s)`);
                    return invalidate();
                  })
                  .catch((error: unknown) =>
                    toast.error(error instanceof Error ? error.message : String(error)),
                  );
              }}
            >
              <Text style={styles.link}>Clear</Text>
            </Pressable>
          </View>
          {settled.map((item) => (
            <View key={item.id} style={styles.item}>
              <Text style={styles.itemMeta} numberOfLines={2}>
                {item.text}
              </Text>
              <Text style={styles.tone[stateTone(item)]}>{stateLabel(item)}</Text>
            </View>
          ))}
        </>
      ) : null}

      <PillSetting
        styles={styles}
        mode={(queue.data?.settings ?? DEFAULT_SETTINGS).pillMode}
        onSaved={invalidate}
      />
    </ScrollView>
  );
}
