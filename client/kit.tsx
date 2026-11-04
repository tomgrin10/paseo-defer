import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Deferred } from "../shared/defer";
import { describeWhen, remainingFraction, timerGlyph } from "../shared/format";
import { PressScale, Spinner } from "./motion";
import { raised, tabular, tint, withAlpha, type Colors, type Theme } from "./theme";

export type { Theme } from "./theme";

/**
 * Re-render on an interval so countdowns keep moving between polls. Pass a
 * shorter interval near the end of a wait; the hook follows changes to it.
 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** One second inside the last two minutes of any wait shown, fifteen otherwise. */
export function tickFor(items: readonly Deferred[], now: number): number {
  const close = items.some((item) => item.dueAt !== null && Math.abs(Date.parse(item.dueAt) - now) < 120_000);
  return close ? 1_000 : 15_000;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The family type scale: tabular numerals wherever a time or count can appear. */
export const text = (colors: Colors) => ({
  title: { color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" as const },
  body: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
  meta: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 17, ...tabular },
  small: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15, ...tabular },
  label: { color: colors.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" as const },
  group: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" as const, ...tabular },
});

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";
/** One button vocabulary for the plugin: 28–32px with a hit slop on desktop, 44px on touch layouts. */
export function Button({ title, onPress, theme, kind = "secondary", disabled = false, loading = false, icon, compact = false, small = false, accessibilityLabel, accessibilityHint, grow = false }: {
  title: string; onPress: () => void; theme: Theme; kind?: ButtonKind; disabled?: boolean; loading?: boolean; icon?: string; compact?: boolean; small?: boolean; accessibilityLabel?: string; accessibilityHint?: string; grow?: boolean;
}) {
  const c = theme.colors;
  const fg = kind === "primary" ? c.accentForeground : kind === "danger" ? c.statusDanger : c.foreground;
  const inactive = disabled || loading;
  const height = compact ? 44 : small ? 28 : 32;
  return <PressScale accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: inactive, busy: loading }}
    disabled={inactive} onPress={onPress} hitSlop={compact ? 0 : 4} outerStyle={grow ? { flexGrow: 1 } : { alignSelf: "flex-start" }}
    style={({ pressed, hovered }) => ({
      minHeight: height, paddingHorizontal: compact ? 14 : small ? 9 : 11, borderRadius: compact ? 8 : 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      opacity: disabled ? 0.45 : 1,
      ...(kind === "primary" ? { backgroundColor: pressed ? withAlpha(c.accent, 0.85) : hovered ? withAlpha(c.accent, 0.92) : c.accent }
        : kind === "ghost" || kind === "danger" ? { backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent" }
        : { ...raised(c), backgroundColor: pressed ? c.surface2 : hovered ? c.surface2 : c.surface1 }),
    })}>
    {loading ? <Spinner color={fg} size={12} /> : icon ? <Icon name={icon} size={compact ? 16 : 14} color={fg} /> : null}
    <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? 14 : small ? 12 : 13, lineHeight: compact ? 19 : 16, fontWeight: kind === "primary" ? "600" : "500", ...tabular }}>{title}</Text>
  </PressScale>;
}

/** A square icon-only control with an accessible name. */
export function IconButton({ icon, label, onPress, theme, compact = false, disabled = false, color }: { icon: string; label: string; onPress: () => void; theme: Theme; compact?: boolean; disabled?: boolean; color?: string }) {
  const c = theme.colors;
  const size = compact ? 44 : 28;
  return <PressScale accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={compact ? 0 : 6}
    style={({ pressed, hovered }) => ({ width: size, height: size, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent", opacity: disabled ? 0.45 : 1 })}>
    <Icon name={icon} size={compact ? 18 : 15} color={color ?? c.foregroundMuted} />
  </PressScale>;
}

/** A raised container. Groups of rows sit inside one; rows divide with hairlines. */
export function Card({ theme, children, style }: { theme: Theme; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = theme.colors;
  return <View style={[{ borderRadius: 10, overflow: "hidden", backgroundColor: c.surface0 }, raised(c), style]}>{children}</View>;
}

/**
 * The timer glyph: a stopwatch whose ring drains as the wait runs out, the
 * same object in the pill, the chat row and the Deferred screen. Sending shows
 * a spinner; a message that is due and held, or whose reset is not known yet,
 * shows an hourglass.
 */
export function TimerGlyph({ item, now, size, color }: { item: Deferred; now: number; size: number; color: string }) {
  if (item.state === "sending") return <Spinner color={color} size={size - 2} label="Sending" />;
  const fraction = remainingFraction(item, now);
  if (fraction === null || fraction <= 0) return <Icon name="Hourglass" size={size} color={color} />;
  return <Icon icon={{ svg: timerGlyph(fraction) }} size={size} color={color} />;
}

/** "4:42 PM  in 47m" with the glyph: how every waiting message starts. */
export function WhenLine({ item, now, theme, size = "md" }: { item: Deferred; now: number; theme: Theme; size?: "md" | "lg" }) {
  const c = theme.colors;
  const when = describeWhen(item, now);
  const big = size === "lg";
  return <View style={{ flexDirection: "row", alignItems: "center", gap: big ? 8 : 7, flexWrap: "wrap", rowGap: 2 }}>
    <TimerGlyph item={item} now={now} size={big ? 16 : 14} color={when.phase === "waiting" ? c.foreground : c.foregroundMuted} />
    <Text style={{ color: c.foreground, fontSize: big ? 17 : 14, lineHeight: big ? 22 : 19, fontWeight: "600", ...tabular }}>{when.time}</Text>
    <Text style={{ color: c.foregroundMuted, fontSize: big ? 13 : 12, lineHeight: 17, flexShrink: 1, ...tabular }}>{when.detail}</Text>
  </View>;
}

/** A neutral selectable chip: selection is a foreground ring on surface2, never the accent. */
export function choiceStyle(colors: Colors, on: boolean, state: { pressed: boolean; hovered?: boolean }): ViewStyle {
  return {
    minHeight: 30, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, justifyContent: "center",
    borderColor: on ? colors.foreground : colors.border,
    backgroundColor: on ? colors.surface2 : state.pressed ? colors.surface2 : state.hovered ? colors.surface1 : "transparent",
  };
}

/** A count or status tag in its own hue at 12–16% (Follow-up's chip). */
export function Chip({ theme, label, color }: { theme: Theme; label: string; color?: string }) {
  const c = theme.colors;
  const hue = color ?? c.foregroundMuted;
  return <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: tint(hue, c), alignSelf: "center" }}>
    <Text numberOfLines={1} style={{ color: hue, fontSize: 11, lineHeight: 16, fontWeight: "600", ...tabular }}>{label}</Text>
  </View>;
}

/** A group heading with its count: "Today  2". */
export function GroupLabel({ theme, label, count, color }: { theme: Theme; label: string; count?: number; color?: string }) {
  const c = theme.colors;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
    <Text accessibilityRole="header" style={{ color: color ?? c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{label}</Text>
    {count === undefined ? null : <Chip theme={theme} label={String(count)} color={color} />}
  </View>;
}

export interface RowActionsOptions {
  theme: Theme;
  compact: boolean;
  /** Each action is offered only when its handler is given. */
  snooze?: { label: string; onPress: () => void } | undefined;
  send?: { label: string; title: string; hint?: string; onPress: () => void } | undefined;
  edit?: { label: string; title: string; onPress: () => void } | undefined;
  /** Shown instead of Edit while this message is open in the composer. */
  editing?: boolean | undefined;
  resend?: { label: string; title: string; onPress: () => void } | undefined;
  /** The way out, set apart on the right: Cancel for a waiting message, Dismiss for a failed one. */
  end?: { label: string; title: string; onPress: () => void; disabled?: boolean } | undefined;
  disabled?: boolean | undefined;
}

/**
 * The one action row every view uses for a deferred message: the timing
 * actions on the left as bordered buttons, the way out on the right.
 * A plain function rather than a component, so each row's buttons stay in
 * that row's own element tree.
 */
export function rowActions(o: RowActionsOptions) {
  const common = { theme: o.theme, small: true, compact: o.compact, disabled: o.disabled === true };
  const icon = (name: string) => (o.compact ? undefined : name);
  // A message open in the composer cannot be sent or snoozed from under it.
  const held = o.disabled === true || o.editing === true;
  return <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, rowGap: 6 }}>
    {o.snooze ? <Button {...common} disabled={held} kind="secondary" icon={icon("TimerReset")} title="+10m" accessibilityLabel={o.snooze.label} onPress={o.snooze.onPress} /> : null}
    {o.send ? <Button {...common} disabled={held} kind="secondary" icon={icon("SendHorizontal")} title={o.send.title} accessibilityLabel={o.send.label} accessibilityHint={o.send.hint} onPress={o.send.onPress} /> : null}
    {o.resend ? <Button {...common} kind="secondary" icon={icon("RotateCw")} title={o.resend.title} accessibilityLabel={o.resend.label} onPress={o.resend.onPress} /> : null}
    {o.editing ? (
      <View style={{ minHeight: o.compact ? 44 : 28, justifyContent: "center", paddingHorizontal: 9 }}>
        <Text style={{ color: o.theme.colors.foregroundMuted, fontSize: 12 }}>Editing</Text>
      </View>
    ) : o.edit ? <Button {...common} kind="secondary" icon={icon("Pencil")} title={o.edit.title} accessibilityLabel={o.edit.label} onPress={o.edit.onPress} /> : null}
    <View style={{ flexGrow: 1, minWidth: 8 }} />
    {o.end ? <Button {...common} kind="ghost" title={o.end.title} accessibilityLabel={o.end.label} disabled={o.disabled === true || o.end.disabled === true} onPress={o.end.onPress} /> : null}
  </View>;
}
