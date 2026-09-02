import { type PluginHostProps, type PluginTheme, useRpc } from "@getpaseo/plugin";
import { useMutation } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  createDeferred,
  updateDeferred,
  updateSettings,
  type Deferred,
  type PillMode,
  type Trigger,
} from "./defer.shared";
import {
  clockPlaceholder,
  describeInstant,
  formatClock,
  formatDuration,
  formatRelative,
  parseDuration,
  parseNextClockTime,
  triggersMatch,
  uses12HourClock,
  type Meridiem,
} from "./format.shared";

type Layout = PluginHostProps["layout"];
type Choice = { id: string; label: string; trigger: () => Trigger | null };
type Controls = { selected: string; clock: string; duration: string };

const MINUTE = 60_000;

/** Relative presets, kept as data so an edit can map a trigger back to a chip. */
const PRESETS = [
  { id: "15m", label: "15m", ms: 15 * MINUTE },
  { id: "1h", label: "1h", ms: 60 * MINUTE },
  { id: "3h", label: "3h", ms: 180 * MINUTE },
];

/** Which chip, wait, and clock text reproduce an already queued trigger. */
function controlsForItem(item: Deferred): Controls {
  const trigger = item.trigger;
  if (trigger.kind === "sessionReset") return { selected: "reset", clock: "", duration: "" };
  if (trigger.kind === "after") {
    const preset = PRESETS.find((candidate) => candidate.ms === trigger.ms);
    if (preset) return { selected: preset.id, clock: "", duration: "" };
    // A typed wait comes back as the same wait rather than as the clock time it
    // resolved to, so leaving the timing alone cannot re-anchor it.
    return { selected: "in", clock: "", duration: formatDuration(trigger.ms) };
  }
  return { selected: "at", duration: "", clock: item.dueAt === null ? "" : formatClock(item.dueAt) };
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
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 12,
      gap: 2,
    },
    targetTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    targetMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    input: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      minHeight: layout.compact ? 72 : 96,
      textAlignVertical: "top" as const,
    },
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
    chip: {
      paddingVertical: 7,
      paddingHorizontal: 12,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    chipOn: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    chipText: { color: theme.colors.foreground, fontSize: 13 },
    chipTextOn: { color: theme.colors.accentForeground, fontSize: 13 },
    sessionChip: {
      paddingVertical: 7,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      maxWidth: 280,
      gap: 1,
    },
    clock: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      minWidth: 76,
    },
    filter: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      minWidth: 160,
    },
    button: { marginTop: 4, padding: 13, borderRadius: 10, backgroundColor: theme.colors.accent },
    buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const, fontWeight: "600" as const },
    danger: { color: theme.colors.statusDanger, fontSize: 12 },
    item: { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingVertical: 10, gap: 4 },
    itemText: { color: theme.colors.foreground, fontSize: 13 },
    itemMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    link: { color: theme.colors.foregroundMuted, fontSize: 11, textDecorationLine: "underline" as const },
    tone: {
      muted: { color: theme.colors.foregroundMuted, fontSize: 11 },
      success: { color: theme.colors.statusSuccess, fontSize: 11 },
      warning: { color: theme.colors.statusWarning, fontSize: 11 },
      danger: { color: theme.colors.statusDanger, fontSize: 11 },
    },
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
  /**
   * Called once a *new* message is queued, after `onSaved`. A view that has
   * somewhere to return to uses this to leave; an edit never fires it, because
   * saving a change is not a reason to move the user.
   */
  onCreated?: ((item: Deferred) => void) | undefined;
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
  onCreated,
}: DeferComposerProps) {
  const create = useRpc(createDeferred);
  const update = useRpc(updateDeferred);

  const [text, setText] = useState("");
  const [selected, setSelected] = useState("15m");
  const [durationInput, setDurationInput] = useState("");
  const [clockInput, setClockInput] = useState("");
  /** Null means "whichever 9:30 comes first"; a value pins the half of the day. */
  const [meridiem, setMeridiem] = useState<Meridiem | null>(null);
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
      setDurationInput("");
      setMeridiem(null);
      return;
    }
    const controls = controlsForItem(editing);
    setText(editing.text);
    setSelected(controls.selected);
    setClockInput(controls.clock);
    setDurationInput(controls.duration);
    // The loaded clock text carries its own AM/PM, so nothing needs pinning.
    setMeridiem(null);
  }, [editing, editingId]);

  const hour12 = uses12HourClock();

  const choices: Choice[] = useMemo(
    () => [
      ...PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        trigger: (): Trigger => ({ kind: "after", ms: preset.ms }),
      })),
      {
        id: "in",
        label: "In…",
        trigger: () => {
          const ms = parseDuration(durationInput);
          return ms === null ? null : { kind: "after", ms };
        },
      },
      {
        id: "at",
        label: "At…",
        trigger: () => {
          const iso = parseNextClockTime(clockInput, { meridiem, hour12 });
          return iso === null ? null : { kind: "at", iso };
        },
      },
      { id: "reset", label: "Session reset", trigger: () => ({ kind: "sessionReset" }) },
    ],
    [clockInput, durationInput, hour12, meridiem],
  );

  // Resolved as you type, so a wait or a time is confirmed as an actual moment
  // before it is queued. This is the whole answer to "9:30 — but which one?".
  const waitMs = parseDuration(durationInput);
  const clockIso = parseNextClockTime(clockInput, { meridiem, hour12 });
  const waitHint =
    waitMs === null
      ? "Minutes unless you say otherwise: 3, 45m, 2h, 1h 30m."
      : `Sends ${describeInstant(new Date(Date.now() + waitMs).toISOString())}.`;
  const clockHint =
    clockIso === null
      ? `Local time, 24-hour or with am/pm: ${clockPlaceholder(hour12)}.`
      : `Sends ${describeInstant(clockIso)}.`;

  const submit = useMutation({
    mutationFn: async (trigger: Trigger): Promise<{ created: Deferred | null }> => {
      const body = text.trim();
      if (editing === null) {
        if (agentId === null) throw new Error("Pick a session first.");
        const { item } = await create({ agentId, text: body, trigger });
        return { created: item };
      }
      // Leave timing untouched unless the selection points somewhere else, so
      // fixing a typo cannot silently restart a countdown.
      const retiming = !triggersMatch(trigger, editing);
      const result = await update({ id: editing.id, text: body, ...(retiming ? { trigger } : {}) });
      if (result.error !== null) throw new Error(result.error);
      return { created: null };
    },
    onSuccess: ({ created }) => {
      setText("");
      setClockInput("");
      setDurationInput("");
      setMeridiem(null);
      setProblem(null);
      onEditingChange(null);
      onSaved();
      // Last: this may navigate away and unmount the composer.
      if (created !== null) onCreated?.(created);
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
      setProblem(
        selected === "in"
          ? "Enter a wait like 3, 45m or 1h 30m, up to 30 days."
          : `Enter a time like ${clockPlaceholder(hour12)}.`,
      );
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
      </View>

      {selected === "in" ? (
        <>
          <View style={styles.row}>
            <TextInput
              style={styles.clock}
              value={durationInput}
              onChangeText={setDurationInput}
              placeholder="20m"
              placeholderTextColor={theme.colors.foregroundMuted}
              accessibilityLabel="How long to wait"
            />
          </View>
          <Text style={styles.hint}>{waitHint}</Text>
        </>
      ) : null}

      {selected === "at" ? (
        <>
          <View style={styles.row}>
            <TextInput
              style={styles.clock}
              value={clockInput}
              onChangeText={setClockInput}
              placeholder={clockPlaceholder(hour12)}
              placeholderTextColor={theme.colors.foregroundMuted}
              accessibilityLabel="Delivery time"
            />
            {/* Only where the clock is ambiguous. A 24-hour device needs no half. */}
            {hour12
              ? (["am", "pm"] as const).map((half) => {
                  const on = meridiem === half;
                  const label = half.toUpperCase();
                  return (
                    <Pressable
                      key={half}
                      accessibilityRole="button"
                      accessibilityLabel={`Deliver in the ${label}`}
                      accessibilityState={{ selected: on }}
                      onPress={() => setMeridiem(on ? null : half)}
                      style={[styles.chip, on ? styles.chipOn : null]}
                    >
                      <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
                    </Pressable>
                  );
                })
              : null}
          </View>
          <Text style={styles.hint}>{clockHint}</Text>
        </>
      ) : null}

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

const PILL_MODES: readonly { id: PillMode; label: string }[] = [
  { id: "always", label: "Every session" },
  { id: "waiting", label: "Only when waiting" },
];

export interface PillSettingProps {
  styles: DeferStyles;
  mode: PillMode;
  onSaved(): void;
}

/**
 * Where the composer pill lives, for anyone who does not want a `Defer` button
 * above every session. Shown in both views because it applies to all of them,
 * and because turning the pill off has to be undoable from somewhere that is
 * not the pill.
 */
export function PillSetting({ styles, mode, onSaved }: PillSettingProps) {
  const save = useRpc(updateSettings);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<PillMode | null>(null);
  // Optimistic, so a chip responds before the queue is re-read.
  const shown = pending ?? mode;

  function choose(next: PillMode) {
    if (next === shown) return;
    setPending(next);
    setProblem(null);
    void save({ pillMode: next })
      .then(() => onSaved())
      .catch((error: unknown) => {
        setPending(null);
        setProblem(error instanceof Error ? error.message : String(error));
      });
  }

  return (
    <>
      <Text style={styles.section}>Composer pill</Text>
      <View style={styles.row}>
        {PILL_MODES.map((option) => {
          const on = option.id === shown;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityLabel={`Show the composer pill on ${option.label.toLowerCase()}`}
              accessibilityState={{ selected: on }}
              onPress={() => choose(option.id)}
              style={[styles.chip, on ? styles.chipOn : null]}
            >
              <Text style={on ? styles.chipTextOn : styles.chipText}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>
        {shown === "always"
          ? "A Defer button sits above every composer, and shows the queue once a session has one."
          : "The pill only appears where something is waiting. Reach Defer from ⌘K or the Deferred sidebar."}
      </Text>
      {problem !== null ? <Text style={styles.danger}>{problem}</Text> : null}
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
  /** Omitted where the view is already inside the target session, or where the
   * host is too old to expose navigation. */
  onOpenSession?: ((item: Deferred) => void) | undefined;
}

/** One waiting message, with the edit and cancel affordances. */
export function DeferredRow({
  styles,
  item,
  meta,
  editing,
  onEdit,
  onCancel,
  onOpenSession,
}: DeferredRowProps) {
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
        {onOpenSession === undefined ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the session this message will land in"
            onPress={() => onOpenSession(item)}
          >
            <Text style={styles.link}>Open session</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
