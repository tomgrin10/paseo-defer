import { type PluginHostProps, type PluginTheme, useRpc } from "@getpaseo/plugin";
import { useMutation } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { createDeferred, updateDeferred, type Deferred, type Trigger } from "./defer.shared";
import { formatClock, formatRelative, parseNextClockTime, triggersMatch } from "./format.shared";

type Layout = PluginHostProps["layout"];
type Choice = { id: string; label: string; trigger: () => Trigger | null };

const MINUTE = 60_000;

/** Relative presets, kept as data so an edit can map a trigger back to a chip. */
const PRESETS = [
  { id: "15m", label: "15m", ms: 15 * MINUTE },
  { id: "1h", label: "1h", ms: 60 * MINUTE },
  { id: "3h", label: "3h", ms: 180 * MINUTE },
];

/** Which chip (and clock text) reproduces an already queued trigger. */
function controlsForItem(item: Deferred): { selected: string; clock: string } {
  const trigger = item.trigger;
  if (trigger.kind === "sessionReset") return { selected: "reset", clock: "" };
  if (trigger.kind === "after") {
    const preset = PRESETS.find((candidate) => candidate.ms === trigger.ms);
    if (preset) return { selected: preset.id, clock: "" };
  }
  // An absolute time, or a relative one no longer offered as a chip.
  return { selected: "at", clock: item.dueAt === null ? "" : formatClock(item.dueAt) };
}

/** One style sheet for every Defer view, so the panel and surface stay in step. */
export function deferStyles(theme: PluginTheme, layout: Layout) {
  const pad = layout.compact ? 16 : 24;
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    body: { padding: pad, gap: layout.compact ? 10 : 14 },
    heading: { color: theme.colors.foreground, fontSize: layout.compact ? 16 : 18, fontWeight: "600" as const },
    title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" as const },
    section: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, marginTop: 8 },
    hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
    target: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 12,
      gap: 2,
    },
    targetTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    targetMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
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
    sessionChip: {
      paddingVertical: 7,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      maxWidth: 280,
      gap: 1,
    },
    clock: {
      color: theme.colors.foreground,
      borderColor: theme.colors.foregroundMuted,
      borderWidth: 1,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      minWidth: 76,
    },
    filter: {
      color: theme.colors.foreground,
      borderColor: theme.colors.foregroundMuted,
      borderWidth: 1,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      minWidth: 160,
    },
    button: { marginTop: 4, padding: 13, borderRadius: 10, backgroundColor: theme.colors.accent },
    buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const, fontWeight: "600" as const },
    danger: { color: theme.colors.statusDanger, fontSize: 12 },
    item: { borderTopWidth: 1, borderTopColor: theme.colors.foregroundMuted, paddingVertical: 10, gap: 4 },
    itemText: { color: theme.colors.foreground, fontSize: 13 },
    itemMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    link: { color: theme.colors.foregroundMuted, fontSize: 11, textDecorationLine: "underline" as const },
  };
}

export type DeferStyles = ReturnType<typeof deferStyles>;

export interface DeferComposerProps {
  theme: PluginTheme;
  styles: DeferStyles;
  /** Target session, or null while the caller still has none picked. */
  agentId: string | null;
  resetsAt: string | null;
  usageError: string | null;
  /** Non-null puts the composer in edit mode for that queued message. */
  editing: Deferred | null;
  onEditingChange(item: Deferred | null): void;
  onSaved(): void;
}

/** Message box, timing chips, and the create/edit submit shared by both views. */
export function DeferComposer({
  theme,
  styles,
  agentId,
  resetsAt,
  usageError,
  editing,
  onEditingChange,
  onSaved,
}: DeferComposerProps) {
  const create = useRpc(createDeferred);
  const update = useRpc(updateDeferred);

  const [text, setText] = useState("");
  const [selected, setSelected] = useState("15m");
  const [clockInput, setClockInput] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const editingId = editing?.id ?? null;
  const loadedId = useRef<string | null>(null);

  // Load the form when an edit starts, and clear it when one ends. Keyed on the
  // id so polling the queue does not overwrite what is being typed.
  useEffect(() => {
    if (loadedId.current === editingId) return;
    loadedId.current = editingId;
    setProblem(null);
    if (editing === null) {
      setText("");
      setClockInput("");
      return;
    }
    const controls = controlsForItem(editing);
    setText(editing.text);
    setSelected(controls.selected);
    setClockInput(controls.clock);
  }, [editing, editingId]);

  const choices: Choice[] = useMemo(
    () => [
      ...PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        trigger: (): Trigger => ({ kind: "after", ms: preset.ms }),
      })),
      {
        id: "at",
        label: "At…",
        trigger: () => {
          const iso = parseNextClockTime(clockInput);
          return iso === null ? null : { kind: "at", iso };
        },
      },
      { id: "reset", label: "Session reset", trigger: () => ({ kind: "sessionReset" }) },
    ],
    [clockInput],
  );

  const submit = useMutation({
    mutationFn: async (trigger: Trigger) => {
      const body = text.trim();
      if (editing === null) {
        if (agentId === null) throw new Error("Pick a session first.");
        return create({ agentId, text: body, trigger });
      }
      // Leave timing untouched unless the selection points somewhere else, so
      // fixing a typo cannot silently restart a countdown.
      const retiming = !triggersMatch(trigger, editing);
      const result = await update({ id: editing.id, text: body, ...(retiming ? { trigger } : {}) });
      if (result.error !== null) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      setText("");
      setClockInput("");
      setProblem(null);
      onEditingChange(null);
      onSaved();
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  const isEditing = editing !== null;
  const canSubmit =
    text.trim() !== "" && !submit.isPending && (isEditing || agentId !== null);

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
    <>
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
            ? usageError ?? "Usage window unavailable; delivery starts once it can be read."
            : `Next reset ${formatClock(resetsAt)} (${formatRelative(resetsAt)}).`}
        </Text>
      ) : null}

      {isEditing ? (
        <Text style={styles.hint}>Timing only changes if you pick a different option.</Text>
      ) : null}

      {problem !== null ? <Text style={styles.danger}>{problem}</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isEditing ? "Save this deferred message" : "Defer this message"}
        disabled={!canSubmit}
        onPress={onSubmit}
        style={[styles.button, { opacity: canSubmit ? 1 : 0.5 }]}
      >
        <Text style={styles.buttonText}>
          {isEditing
            ? submit.isPending
              ? "Saving…"
              : "Save changes"
            : submit.isPending
              ? "Deferring…"
              : "Defer"}
        </Text>
      </Pressable>

      {isEditing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop editing"
          onPress={() => onEditingChange(null)}
        >
          <Text style={styles.link}>Cancel edit</Text>
        </Pressable>
      ) : null}
    </>
  );
}

export interface DeferredRowProps {
  styles: DeferStyles;
  item: Deferred;
  /** Trailing detail line, e.g. which session a queued message belongs to. */
  meta: string;
  editing: boolean;
  onEdit(item: Deferred): void;
  onCancel(item: Deferred): void;
}

/** One waiting message, with the edit and cancel affordances. */
export function DeferredRow({ styles, item, meta, editing, onEdit, onCancel }: DeferredRowProps) {
  return (
    <View style={styles.item}>
      <Text style={styles.itemText} numberOfLines={3}>
        {item.text}
      </Text>
      <View style={styles.row}>
        <Text style={styles.itemMeta}>{meta}</Text>
        {item.state === "pending" ? (
          editing ? (
            <Text style={styles.itemMeta}>editing above</Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit this deferred message"
              onPress={() => onEdit(item)}
            >
              <Text style={styles.link}>Edit</Text>
            </Pressable>
          )
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel this deferred message"
          onPress={() => onCancel(item)}
        >
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
