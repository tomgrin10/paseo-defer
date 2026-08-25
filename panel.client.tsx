import {
  type PluginAgentPanelProps,
  useAgent,
  useRpc,
} from "@getpaseo/plugin";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { cancelDeferred, clearSettled, createDeferred, listDeferred, type Trigger } from "./defer.shared";
import { formatClock, formatRelative, parseNextClockTime, stateLabel } from "./format.shared";

type Choice = { id: string; label: string; trigger: () => Trigger | null };

const MINUTE = 60_000;

export function DeferPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const status = useAgent(agentId, (agent) => agent.status);
  const list = useRpc(listDeferred);
  const create = useRpc(createDeferred);
  const cancel = useRpc(cancelDeferred);
  const clear = useRpc(clearSettled);
  const queryClient = useQueryClient();
  const queryKey = ["defer", agentId];

  const [text, setText] = useState("");
  const [selected, setSelected] = useState("15m");
  const [clockInput, setClockInput] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const queue = useQuery({
    queryKey,
    queryFn: () => list({ agentId }),
    refetchInterval: 10_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const submit = useMutation({
    mutationFn: (trigger: Trigger) => create({ agentId, text: text.trim(), trigger }),
    onSuccess: () => {
      setText("");
      setClockInput("");
      setProblem(null);
      void invalidate();
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  const choices: Choice[] = [
    { id: "15m", label: "15m", trigger: () => ({ kind: "after", ms: 15 * MINUTE }) },
    { id: "1h", label: "1h", trigger: () => ({ kind: "after", ms: 60 * MINUTE }) },
    { id: "3h", label: "3h", trigger: () => ({ kind: "after", ms: 180 * MINUTE }) },
    {
      id: "at",
      label: "At…",
      trigger: () => {
        const iso = parseNextClockTime(clockInput);
        return iso === null ? null : { kind: "at", iso };
      },
    },
    { id: "reset", label: "Session reset", trigger: () => ({ kind: "sessionReset" }) },
  ];

  const styles = useMemo(() => {
    const pad = layout.compact ? 16 : 24;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      body: { padding: pad, gap: layout.compact ? 10 : 14 },
      heading: { color: theme.colors.foreground, fontSize: layout.compact ? 16 : 18, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.foregroundMuted,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        minHeight: layout.compact ? 72 : 96,
        textAlignVertical: "top" as const,
      },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
      chip: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.foregroundMuted },
      chipOn: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      chipText: { color: theme.colors.foreground, fontSize: 13 },
      chipTextOn: { color: theme.colors.accentForeground, fontSize: 13 },
      clock: {
        color: theme.colors.foreground,
        borderColor: theme.colors.foregroundMuted,
        borderWidth: 1,
        borderRadius: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        minWidth: 76,
      },
      button: { marginTop: 4, padding: 13, borderRadius: 10, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const, fontWeight: "600" as const },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      item: { borderTopWidth: 1, borderTopColor: theme.colors.foregroundMuted, paddingVertical: 10, gap: 4 },
      itemText: { color: theme.colors.foreground, fontSize: 13 },
      itemMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      link: { color: theme.colors.foregroundMuted, fontSize: 11, textDecorationLine: "underline" as const },
    };
  }, [theme, layout.compact]);

  const canSubmit = text.trim() !== "" && !submit.isPending;
  const resetsAt = queue.data?.sessionResetsAt ?? null;
  const items = queue.data?.items ?? [];
  const pending = items.filter((item) => item.state === "pending" || item.state === "sending");
  const settled = items.filter((item) => item.state !== "pending" && item.state !== "sending");

  function onSubmit() {
    if (text.trim() === "") return;
    const choice = choices.find((candidate) => candidate.id === selected);
    const trigger = choice?.trigger() ?? null;
    if (trigger === null) {
      setProblem("Enter a time like 9:30 or 21:00.");
      return;
    }
    submit.mutate(trigger);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <Text style={styles.heading}>Defer a message</Text>
      <Text style={styles.hint}>
        {status === "idle"
          ? "This session is idle, so a due message is delivered on the next check."
          : "Delivery waits until this session finishes its current turn."}
      </Text>

      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Message to send later…"
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
        accessibilityLabel="Message to defer"
      />

      <View style={styles.row}>
        {choices.map((choice) => {
          const on = choice.id === selected;
          return (
            <Pressable
              key={choice.id}
              accessibilityRole="button"
              accessibilityLabel={`Deliver ${choice.label}`}
              accessibilityState={{ selected: on }}
              onPress={() => setSelected(choice.id)}
              style={[styles.chip, on ? styles.chipOn : null]}
            >
              <Text style={on ? styles.chipTextOn : styles.chipText}>
                {choice.id === "reset" && resetsAt !== null ? `Session reset · ${formatClock(resetsAt)}` : choice.label}
              </Text>
            </Pressable>
          );
        })}
        {selected === "at" ? (
          <TextInput
            style={styles.clock}
            value={clockInput}
            onChangeText={setClockInput}
            placeholder="9:30"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Delivery time, 24 hour clock"
          />
        ) : null}
      </View>

      {selected === "reset" ? (
        <Text style={styles.hint}>
          {resetsAt === null
            ? queue.data?.usageError ?? "Usage window unavailable; delivery starts once it can be read."
            : `Next reset ${formatClock(resetsAt)} (${formatRelative(resetsAt)}).`}
        </Text>
      ) : null}

      {problem !== null ? <Text style={styles.danger}>{problem}</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Defer this message"
        disabled={!canSubmit}
        onPress={onSubmit}
        style={[styles.button, { opacity: canSubmit ? 1 : 0.5 }]}
      >
        <Text style={styles.buttonText}>{submit.isPending ? "Deferring…" : "Defer"}</Text>
      </Pressable>

      <Text style={styles.heading}>{`Deferred (${pending.length})`}</Text>
      {pending.length === 0 ? <Text style={styles.hint}>Nothing waiting for this session.</Text> : null}
      {pending.map((item) => (
        <View key={item.id} style={styles.item}>
          <Text style={styles.itemText} numberOfLines={3}>
            {item.text}
          </Text>
          <View style={styles.row}>
            <Text style={styles.itemMeta}>{stateLabel(item)}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel this deferred message"
              onPress={() => {
                void cancel({ id: item.id }).then(invalidate);
              }}
            >
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        </View>
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
