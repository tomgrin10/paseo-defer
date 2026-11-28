import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginHostProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import {
  createDeferred,
  updateDeferred,
  type Deferred,
  type Trigger,
} from "../shared/defer";
import { onComposerDraftOffered } from "./handoff";
import { canClearComposer, clearComposerIfUnchanged } from "./host-composer";
import {
  clockPlaceholder,
  describeInstant,
  formatClock,
  formatDuration,
  formatRelative,
  formatResetLabel,
  parseDuration,
  parseNextClockTime,
  triggersMatch,
  uses12HourClock,
  type Meridiem,
} from "../shared/format";
import { Button, choiceStyle, rowActions, WhenLine } from "./kit";
import { tabular, withAlpha } from "./theme";

type Layout = PluginHostProps["layout"];
type Choice = { id: string; label: string; trigger: () => Trigger | null };
type Controls = { selected: string; clock: string; duration: string };
type PressState = PressableStateCallbackType & { hovered?: boolean };

const MINUTE = 60_000;

/** Relative presets, kept as data so an edit can map a trigger back to a chip. */
const PRESETS = [
  { id: "15m", label: "15m", ms: 15 * MINUTE },
  { id: "1h", label: "1h", ms: 60 * MINUTE },
  { id: "3h", label: "3h", ms: 180 * MINUTE },
];

/**
 * Which chip, wait, and clock text reproduce a trigger — for an edit, and for a
 * timing that arrived with a hand-over. `at` is shown as the clock time it
 * resolves to: for a queued message that is `dueAt`, and for an offer the
 * instant the trigger already carries.
 */
function controlsForTrigger(trigger: Trigger, dueAt: string | null): Controls {
  if (trigger.kind === "sessionReset") return { selected: "reset", clock: "", duration: "" };
  if (trigger.kind === "after") {
    const preset = PRESETS.find((candidate) => candidate.ms === trigger.ms);
    if (preset) return { selected: preset.id, clock: "", duration: "" };
    // A typed wait comes back as the same wait rather than as the clock time it
    // resolved to, so leaving the timing alone cannot re-anchor it.
    return { selected: "in", clock: "", duration: formatDuration(trigger.ms) };
  }
  const at = dueAt ?? trigger.iso;
  return { selected: "at", duration: "", clock: formatClock(at) };
}

function controlsForItem(item: Deferred): Controls {
  return controlsForTrigger(item.trigger, item.dueAt);
}

/**
 * One style sheet for every Defer view. It carries its theme and layout, so a
 * row handed only `styles` can still draw itself in the host's colours.
 */
export function deferStyles(theme: PluginTheme, layout: Layout) {
  const c = theme.colors;
  const compact = layout.compact;
  return {
    theme,
    compact,
    screen: { flex: 1, backgroundColor: c.surface0 },
    body: { padding: compact ? 16 : 24, gap: compact ? 12 : 16 },
    heading: { color: c.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" as const },
    hint: { color: c.foregroundMuted, fontSize: 12, lineHeight: 17, ...tabular },
    input: {
      color: c.foreground,
      backgroundColor: c.surface1,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 10,
      fontSize: 14,
      lineHeight: 20,
      minHeight: compact ? 76 : 84,
      textAlignVertical: "top" as const,
      outlineWidth: 0,
    },
    inputFocused: { borderColor: withAlpha(c.foreground, 0.42) },
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, alignItems: "center" as const },
    chipText: { color: c.foreground, fontSize: 13, lineHeight: 17, ...tabular },
    field: {
      color: c.foreground,
      backgroundColor: c.surface1,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingVertical: compact ? 10 : 6,
      paddingHorizontal: 10,
      minWidth: 96,
      fontSize: 14,
      outlineWidth: 0,
      ...tabular,
    },
    danger: { color: c.statusDanger, fontSize: 12, lineHeight: 17 },
    note: { flexDirection: "row" as const, gap: 6, alignItems: "flex-start" as const },
    item: { paddingVertical: 11, paddingHorizontal: compact ? 0 : 0, gap: 5 },
    itemText: { color: c.foreground, fontSize: 13, lineHeight: 19 },
    itemMeta: { color: c.foregroundMuted, fontSize: 12, lineHeight: 17, ...tabular },
    divider: { height: 1, backgroundColor: c.border },
    tone: {
      muted: { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 },
      success: { color: c.statusSuccess, fontSize: 12, lineHeight: 17 },
      warning: { color: c.statusWarning, fontSize: 12, lineHeight: 17 },
      danger: { color: c.statusDanger, fontSize: 12, lineHeight: 17 },
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
  /** Share of the 5-hour window already used, when the provider reports it. */
  usedPct?: number | null | undefined;
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
  /**
   * Accept the text already typed in this session's own composer when Defer was
   * opened from it. Only the in-session views set it: the Deferred screen is
   * reached from the sidebar and ⌘K, where there is no one composer to take from.
   */
  acceptComposerDraft?: boolean | undefined;
}

/** Message box, timing chips, and the create/edit submit shared by every view. */
export function DeferComposer({
  theme,
  styles,
  agentId,
  resetsAt,
  usageError,
  usedPct = null,
  editing,
  onEditingChange,
  onSaved,
  onCreated,
  acceptComposerDraft,
}: DeferComposerProps) {
  const create = useRpc(createDeferred);
  const update = useRpc(updateDeferred);
  const c = theme.colors;

  const [text, setText] = useState("");
  const [selected, setSelected] = useState("15m");
  const [durationInput, setDurationInput] = useState("");
  const [clockInput, setClockInput] = useState("");
  /** Null means "whichever 9:30 comes first"; a value pins the half of the day. */
  const [meridiem, setMeridiem] = useState<Meridiem | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  const editingId = editing?.id ?? null;
  const loadedId = useRef<string | null>(null);
  /** The last text taken from the session's composer, while it is still that. */
  const handedOver = useRef<string | null>(null);
  /** Whether that text came from the prompt box, rather than a `/defer` line. */
  const handedOverFromComposer = useRef(false);
  const currentText = useRef(text);
  currentText.current = text;

  // Load the form when an edit starts, and clear it when one ends. Keyed on the
  // id so polling the queue does not overwrite what is being typed.
  useEffect(() => {
    if (loadedId.current === editingId) return;
    loadedId.current = editingId;
    setProblem(null);
    handedOver.current = null;
    if (editing === null) {
      setText("");
      setClockInput("");
      setDurationInput("");
      setMeridiem(null);
      return;
    }
    const controls = controlsForItem(editing);
    setText(editing.text);
    // The fields still load what the message was given, so In… or At… opens
    // on its own wait or time; Keep is what is selected.
    setSelected("keep");
    setClockInput(controls.clock);
    setDurationInput(controls.duration);
    // The loaded clock text carries its own AM/PM, so nothing needs pinning.
    setMeridiem(null);
  }, [editing, editingId]);

  // Text offered by the pill when Defer was opened from this session's composer.
  // It fills an empty box, or replaces an earlier hand-over that has not been
  // touched, and otherwise leaves what is there: a half-written deferred message
  // outranks whatever is in the prompt box.
  useEffect(() => {
    if (acceptComposerDraft !== true || agentId === null || editingId !== null) return;
    return onComposerDraftOffered(agentId, (offer) => {
      // Timing that came with the offer was written out by the user, so it is
      // applied whether or not the message box takes the text with it.
      if (offer.trigger !== null) {
        const controls = controlsForTrigger(offer.trigger, null);
        setSelected(controls.selected);
        setClockInput(controls.clock);
        setDurationInput(controls.duration);
        setMeridiem(null);
      }
      if (offer.text.trim() === "") return;
      const current = currentText.current;
      if (current.trim() !== "" && current !== handedOver.current) return;
      handedOver.current = offer.text;
      handedOverFromComposer.current = offer.fromComposer === true;
      setText(offer.text);
    });
  }, [acceptComposerDraft, agentId, editingId]);

  const hour12 = uses12HourClock();

  const choices: Choice[] = useMemo(
    () => [
      // While editing, the first option is the time the message already has,
      // selected, so nothing re-anchors unless another option is chosen.
      ...(editing === null
        ? []
        : [{ id: "keep", label: "Keep", trigger: (): Trigger => editing.trigger }]),
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
    [clockInput, durationInput, editing, hour12, meridiem],
  );

  // Resolved as you type, so a wait or a time is confirmed as an actual moment
  // before it is queued. This is the whole answer to "9:30 — but which one?".
  const kept = (trigger: Trigger, fresh: string) =>
    editing?.dueAt && triggersMatch(trigger, editing) ? editing.dueAt : fresh;
  const waitMs = parseDuration(durationInput);
  const clockIso = parseNextClockTime(clockInput, { meridiem, hour12 });
  const preset = PRESETS.find((candidate) => candidate.id === selected);
  let resolution: string;
  if (selected === "keep" && editing !== null) {
    resolution = editing.dueAt === null
      ? "Sends at the next session reset"
      : `Sends ${describeInstant(editing.dueAt)}`;
  } else if (preset !== undefined) {
    resolution = `Sends ${describeInstant(kept({ kind: "after", ms: preset.ms }, new Date(Date.now() + preset.ms).toISOString()))}`;
  } else if (selected === "in") {
    resolution =
      waitMs === null
        ? "Minutes unless you say otherwise: 3, 45m, 2h, 1h 30m."
        : `Sends ${describeInstant(kept({ kind: "after", ms: waitMs }, new Date(Date.now() + waitMs).toISOString()))}`;
  } else if (selected === "at") {
    resolution =
      clockIso === null
        ? `Local time, 24-hour or with am/pm: ${clockPlaceholder(hour12)}.`
        : `Sends ${describeInstant(kept({ kind: "at", iso: clockIso }, clockIso))}`;
  } else {
    resolution =
      resetsAt === null
        ? usageError ?? "Usage window unavailable. The message waits until it can be read, then sends at the next reset."
        : `Next reset ${formatResetLabel(resetsAt)} · ${formatRelative(resetsAt)}${usedPct === null ? "" : ` · ${Math.round(usedPct)}% of the window used`}`;
  }

  const submit = useMutation({
    mutationFn: async (trigger: Trigger): Promise<{ created: Deferred | null; taken: string | null }> => {
      const body = text.trim();
      if (editing === null) {
        if (agentId === null) throw new Error("Pick a session first.");
        // Captured before the request: what is queued has to be exactly what
        // was taken from the prompt box for Defer to empty that box afterwards.
        const taken =
          handedOverFromComposer.current && handedOver.current !== null && text === handedOver.current
            ? handedOver.current
            : null;
        const { item } = await create({ agentId, text: body, trigger });
        return { created: item, taken };
      }
      // Leave timing untouched unless the selection points somewhere else, so
      // fixing a typo cannot silently restart a countdown.
      const retiming = !triggersMatch(trigger, editing);
      const result = await update({ id: editing.id, text: body, ...(retiming ? { trigger } : {}) });
      if (result.error !== null) throw new Error(result.error);
      return { created: null, taken: null };
    },
    onSuccess: ({ created, taken }) => {
      // Only once the message is safely queued, and only while the prompt box
      // still holds exactly what was taken: text typed there since stays.
      if (created !== null && taken !== null && agentId !== null) clearComposerIfUnchanged(agentId, taken);
      handedOver.current = null;
      handedOverFromComposer.current = false;
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
  const canSubmit = text.trim() !== "" && !submit.isPending && (isEditing || agentId !== null);
  const fromComposer = handedOver.current !== null && text === handedOver.current && text.trim() !== "";
  // On Paseo 0.16 Defer empties the prompt box itself once this is queued.
  const clearsComposer = fromComposer && handedOverFromComposer.current && agentId !== null && canClearComposer(agentId);

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

  const choiceChip = (id: string, label: string, accessibilityLabel: string, on: boolean, onPress: () => void) => (
    <Pressable
      key={id}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={styles.compact ? 0 : 3}
      style={(state: PressState) => [choiceStyle(c, on, state), styles.compact ? { minHeight: 40, paddingHorizontal: 14 } : null]}
    >
      <Text style={[styles.chipText, on ? { fontWeight: "600" } : null]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ gap: 10 }}>
      <TextInput
        style={[styles.input, focused ? styles.inputFocused : null]}
        value={text}
        onChangeText={setText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Message to send later…"
        placeholderTextColor={c.foregroundMuted}
        multiline
        accessibilityLabel="Message to defer"
      />

      {fromComposer ? (
        // Before Paseo 0.16 a plugin had no way to clear the prompt box, so the
        // copy left there would go out a second time if sent.
        <View style={styles.note}>
          <View style={{ paddingTop: 1 }}>
            <Icon name="Copy" size={13} color={c.foregroundMuted} />
          </View>
          <Text style={[styles.hint, { flex: 1 }]}>
            {clearsComposer
              ? "Taken from your message box. Defer clears it there once this is queued."
              : "Copied from your message box. Clear it there so it isn't sent twice."}
          </Text>
        </View>
      ) : null}

      <View style={styles.row}>
        {choices.map((choice) =>
          choiceChip(
            choice.id,
            choice.id === "reset" && resetsAt !== null
              ? `Session reset · ${formatResetLabel(resetsAt)}`
              : choice.id === "keep" && editing !== null
                ? `Keep · ${editing.dueAt === null ? "at reset" : formatResetLabel(editing.dueAt)}`
                : choice.label,
            choice.id === "keep" ? "Keep the current send time" : `Deliver ${choice.label}`,
            choice.id === selected,
            () => setSelected(choice.id),
          ),
        )}
      </View>

      {selected === "in" ? (
        <View style={styles.row}>
          <TextInput
            style={styles.field}
            value={durationInput}
            onChangeText={setDurationInput}
            placeholder="20m"
            placeholderTextColor={c.foregroundMuted}
            accessibilityLabel="How long to wait"
          />
        </View>
      ) : null}

      {selected === "at" ? (
        <View style={styles.row}>
          <TextInput
            style={styles.field}
            value={clockInput}
            onChangeText={setClockInput}
            placeholder={clockPlaceholder(hour12)}
            placeholderTextColor={c.foregroundMuted}
            accessibilityLabel="Delivery time"
          />
          {/* Only where the clock is ambiguous. A 24-hour device needs no half. */}
          {hour12
            ? (["am", "pm"] as const).map((half) => {
                const on = meridiem === half;
                const label = half.toUpperCase();
                return choiceChip(half, label, `Deliver in the ${label}`, on, () => setMeridiem(on ? null : half));
              })
            : null}
        </View>
      ) : null}

      {selected === "reset" && resetsAt !== null && usedPct !== null ? (
        <UsageBar theme={theme} usedPct={usedPct} />
      ) : null}

      <Text style={styles.hint}>{resolution}</Text>

      {problem !== null ? <Text accessibilityRole="alert" style={styles.danger}>{problem}</Text> : null}

      <View style={[styles.row, { gap: 8, marginTop: 2 }, isEditing ? { justifyContent: "flex-end" } : null]}>
        {isEditing ? (
          <Button theme={theme} kind="ghost" compact={styles.compact} title="Cancel edit" accessibilityLabel="Stop editing" onPress={() => onEditingChange(null)} />
        ) : null}
        <Button
          theme={theme}
          kind="primary"
          compact={styles.compact}
          grow={!isEditing}
          title={isEditing ? (submit.isPending ? "Saving…" : "Save changes") : submit.isPending ? "Deferring…" : "Defer"}
          accessibilityLabel={isEditing ? "Save this deferred message" : "Defer this message"}
          disabled={!canSubmit}
          loading={submit.isPending}
          onPress={onSubmit}
        />
      </View>
    </View>
  );
}

/**
 * How much of the rolling window is spent: the reason to pick "Session reset".
 * Warning past 80% and danger past 95%, matching Paseo's own usage meter.
 */
function UsageBar({ theme, usedPct }: { theme: PluginTheme; usedPct: number }) {
  const c = theme.colors;
  const pct = Math.min(100, Math.max(0, usedPct));
  const fill = pct >= 95 ? c.statusDanger : pct >= 80 ? c.statusWarning : c.foregroundMuted;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Usage window"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct), text: `${Math.round(pct)}% used` }}
      style={{ height: 4, borderRadius: 2, backgroundColor: withAlpha(c.foregroundMuted, 0.2), overflow: "hidden" }}
    >
      <View style={{ width: `${pct}%`, height: 4, borderRadius: 2, backgroundColor: fill }} />
    </View>
  );
}

export interface DeferredRowProps {
  styles: DeferStyles;
  item: Deferred;
  /** The session this message lands in, where the view is not already inside it. */
  meta: string;
  editing: boolean;
  onEdit(item: Deferred): void;
  onSendNow(item: Deferred): void;
  scheduling?: boolean;
  onCancel(item: Deferred): void;
  /** Pushes the send time back ten minutes. Omitted where a view has no room for it. */
  onSnooze?: ((item: Deferred) => void) | undefined;
  /** Omitted where the view is already inside the target session, or where the
   * host is too old to expose navigation. */
  onOpenSession?: ((item: Deferred) => void) | undefined;
  /** The clock the countdown is read against; the parent owns the tick. */
  now?: number;
}

/**
 * One waiting message: the time it sends, what it says, where it lands, and
 * what can still be done about it. Hook-free, so any list can render many.
 */
export function DeferredRow({
  styles,
  item,
  meta,
  editing,
  onEdit,
  onSendNow,
  scheduling = false,
  onCancel,
  onSnooze,
  onOpenSession,
  now = Date.now(),
}: DeferredRowProps) {
  const theme = styles.theme;
  const c = theme.colors;
  const compact = styles.compact;
  const pending = item.state === "pending";
  const canSnooze = onSnooze !== undefined && pending && item.trigger?.kind !== "sessionReset" && item.dueAt != null;

  const actions = !pending ? null : rowActions({
    theme,
    compact,
    disabled: scheduling,
    snooze: canSnooze ? { label: "Snooze this deferred message by 10 minutes", onPress: () => onSnooze?.(item) } : undefined,
    send: {
      label: "Send this deferred message now",
      title: scheduling ? "Scheduling…" : "Send now",
      hint: editing ? "Save or cancel your edits before sending" : "Delivery waits until the session is idle",
      onPress: () => onSendNow(item),
    },
    editing,
    edit: { label: "Edit this deferred message", title: "Edit", onPress: () => onEdit(item) },
    end: { label: "Cancel this deferred message", title: "Cancel", onPress: () => onCancel(item) },
  });
  return (
    <View style={styles.item}>
      <WhenLine item={item} now={now} theme={theme} />
      <Text style={styles.itemText} numberOfLines={3}>
        {item.text}
      </Text>
      {meta === "" ? null : onOpenSession === undefined ? (
        <Text style={styles.itemMeta} numberOfLines={1}>{meta}</Text>
      ) : (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open ${meta}`}
          onPress={() => onOpenSession(item)}
          hitSlop={4}
          style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }}
        >
          {(state: PressState) => (
            <>
              <Text style={[styles.itemMeta, { flexShrink: 1 }, state.hovered ? { color: c.foreground, textDecorationLine: "underline" } : null]} numberOfLines={1}>{meta}</Text>
              <Icon name="ArrowUpRight" size={12} color={state.hovered ? c.foreground : c.foregroundMuted} />
            </>
          )}
        </Pressable>
      )}
      {actions}
    </View>
  );
}
