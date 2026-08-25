import {
  type PluginAgentPanelProps,
  useAgent,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { cancelDeferred, clearSettled, listDeferred, type Deferred } from "./defer.shared";
import { DeferComposer, DeferredRow, deferStyles } from "./composer.client";
import { stateLabel } from "./format.shared";

export function DeferPanel({ theme, layout, agentId, workspaceId }: PluginAgentPanelProps) {
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
  const queryClient = useQueryClient();
  const queryKey = ["defer", agentId];

  const [editingId, setEditingId] = useState<string | null>(null);

  const queue = useQuery({
    queryKey,
    queryFn: () => list({ agentId }),
    refetchInterval: 10_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });
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
    void cancel({ id: item.id }).then(invalidate);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <Text style={styles.heading}>{editing === null ? "Defer a message" : "Edit deferred message"}</Text>

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
                void clear({ agentId }).then(invalidate);
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
              <Text style={item.state === "failed" ? styles.danger : styles.itemMeta}>{stateLabel(item)}</Text>
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}
