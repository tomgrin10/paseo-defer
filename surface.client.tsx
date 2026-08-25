import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { cancelDeferred, listDeferred } from "./defer.shared";
import { formatClock, formatRelative, stateLabel } from "./format.shared";

export function DeferOverview({ theme, layout }: PluginSurfaceProps) {
  const list = useRpc(listDeferred);
  const cancel = useRpc(cancelDeferred);
  const queryClient = useQueryClient();
  const queryKey = ["defer", "all"];

  const queue = useQuery({ queryKey, queryFn: () => list({}), refetchInterval: 10_000 });

  const styles = useMemo(() => {
    const pad = layout.compact ? 16 : 24;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      body: { padding: pad, gap: layout.compact ? 10 : 14 },
      heading: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" as const },
      section: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, marginTop: 8 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      item: { borderTopWidth: 1, borderTopColor: theme.colors.foregroundMuted, paddingVertical: 10, gap: 4 },
      itemText: { color: theme.colors.foreground, fontSize: 13 },
      itemMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      danger: { color: theme.colors.statusDanger, fontSize: 11 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
      link: { color: theme.colors.foregroundMuted, fontSize: 11, textDecorationLine: "underline" as const },
    };
  }, [theme, layout.compact]);

  const items = queue.data?.items ?? [];
  const pending = items.filter((item) => item.state === "pending" || item.state === "sending");
  const settled = items.filter((item) => item.state !== "pending" && item.state !== "sending");
  const resetsAt = queue.data?.sessionResetsAt ?? null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <Text style={styles.heading}>Deferred messages</Text>
      <Text style={styles.hint}>
        {resetsAt === null
          ? "Usage window unavailable."
          : `Session resets ${formatClock(resetsAt)} (${formatRelative(resetsAt)}).`}
      </Text>

      <Text style={styles.section}>{`Waiting (${pending.length})`}</Text>
      {pending.length === 0 ? <Text style={styles.hint}>Nothing deferred.</Text> : null}
      {pending.map((item) => (
        <View key={item.id} style={styles.item}>
          <Text style={styles.itemText} numberOfLines={2}>
            {item.text}
          </Text>
          <View style={styles.row}>
            <Text style={styles.itemMeta}>{`${stateLabel(item)} · session ${item.agentId.slice(0, 8)}`}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel this deferred message"
              onPress={() => {
                void cancel({ id: item.id }).then(() => queryClient.invalidateQueries({ queryKey }));
              }}
            >
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ))}

      {settled.length > 0 ? (
        <>
          <Text style={styles.section}>{`History (${settled.length})`}</Text>
          {settled.map((item) => (
            <View key={item.id} style={styles.item}>
              <Text style={styles.itemMeta} numberOfLines={1}>
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
