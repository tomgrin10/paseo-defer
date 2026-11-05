import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import {
  cancelDeferred,
  clearSettled,
  createDeferred,
  deleteDeferred,
  listDeferred,
  listSessions,
  updateDeferred,
  type Deferred,
  type Session,
} from "../shared/defer";
import { DeferComposer, DeferredRow, deferStyles } from "./composer";
import { Button, Card, errorText, GroupLabel, IconButton, rowActions, text, tickFor, useNow } from "./kit";
import { Skeleton } from "./motion";
import { notifyDeferChanged } from "./refresh";
import { useSendNow } from "./send-now";
import { tabular, toneColor, withAlpha } from "./theme";
import {
  byDueAt,
  dayGroup,
  describeActivity,
  formatClock,
  formatCountdown,
  formatDay,
  formatResetLabel,
  isOverdue,
  queuedLabel,
  snoozeTrigger,
} from "../shared/format";

type PressState = PressableStateCallbackType & { hovered?: boolean };

/** Sessions shown in the picker before the filter has to narrow them. */
const PICKER_LIMIT = 8;
const FILTER_THRESHOLD = 6;
/** Recent activity rows before "Show all". */
const ACTIVITY_LIMIT = 6;

function sessionTitle(session: Session | undefined): string {
  const title = session?.title?.trim() ?? "";
  return title === "" ? "Untitled session" : title;
}

function workspaceOf(session: Session | undefined): string {
  // "project / workspace": the workspace half is the one people name.
  const label = session?.workspaceLabel ?? "";
  return label.includes(" / ") ? label.slice(label.lastIndexOf(" / ") + 3) : label;
}

/**
 * The Deferred screen: every waiting message across sessions as a schedule,
 * grouped by when it goes out, then what happened recently. Writing a new
 * message to any session is one button away rather than the first thing on
 * the page; most messages start from a session's own pill.
 */
export function DeferOverview({ theme, layout, navigation, openSettings }: PluginScreenProps & { openSettings?: () => void }) {
  const list = useRpc(listDeferred);
  const sessions = useRpc(listSessions);
  const cancel = useRpc(cancelDeferred);
  const update = useRpc(updateDeferred);
  const clear = useRpc(clearSettled);
  const create = useRpc(createDeferred);
  const remove = useRpc(deleteDeferred);
  const toast = useToast();
  const [resending, setResending] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const [targetId, setTargetId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [allActivity, setAllActivity] = useState(false);

  const sessionList = useQuery({
    queryKey: ["defer", "sessions"],
    queryFn: () => sessions({}),
    refetchInterval: 15_000,
  });
  const rows = sessionList.data?.sessions ?? [];
  // The usage line needs a session to know whose provider to ask; the most
  // recently active one stands in until a target is picked.
  const usageId = targetId ?? rows[0]?.id ?? null;
  const queryKey = ["defer", "all", usageId];
  const queue = useQuery({
    queryKey,
    queryFn: () => list(usageId === null ? {} : { usageAgentId: usageId }),
    refetchInterval: 10_000,
    // Picking a target only changes whose usage window is read; keep the list on screen meanwhile.
    placeholderData: (previous) => previous,
  });

  const invalidate = () => {
    notifyDeferChanged();
    return queryClient.invalidateQueries({ queryKey });
  };
  const send = useSendNow(invalidate);
  const styles = useMemo(() => deferStyles(theme, layout), [theme, layout]);
  const c = theme.colors;
  const t = text(c);
  const compact = layout.compact;

  const items = queue.data?.items ?? [];
  const pending = byDueAt(items.filter((item) => item.state === "pending" || item.state === "sending"));
  const settled = items
    .filter((item) => item.state !== "pending" && item.state !== "sending")
    .sort((a, b) => Date.parse(b.settledAt ?? b.createdAt) - Date.parse(a.settledAt ?? a.createdAt));
  const resetsAt = queue.data?.sessionResetsAt ?? null;
  const usedPct = queue.data?.sessionUsedPct ?? null;
  const editing = items.find((item) => item.id === editingId) ?? null;
  const now = useNow(tickFor(pending, Date.now()));

  const byId = useMemo(() => new Map(rows.map((session) => [session.id, session])), [rows]);
  const needle = filter.trim().toLowerCase();
  const matching = needle === "" ? rows : rows.filter((session) =>
    `${sessionTitle(session)} ${session.workspaceLabel ?? ""}`.toLowerCase().includes(needle));
  const visible = matching.slice(0, PICKER_LIMIT);
  const hidden = matching.length - visible.length;

  /** How a queued message names the session it will land in. */
  function labelFor(agentId: string): string {
    const session = byId.get(agentId);
    if (session === undefined) return sessionList.isSuccess ? "Closed session" : "";
    const workspace = workspaceOf(session);
    return workspace === "" ? sessionTitle(session) : `${sessionTitle(session)} · ${workspace}`;
  }

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

  /** A failed send is never retried on its own; this queues a fresh copy for now and clears the failure. */
  function onResend(item: Deferred) {
    if (resending !== null) return;
    setResending(item.id);
    void create({ agentId: item.agentId, text: item.text, trigger: { kind: "at", iso: new Date().toISOString() } })
      .then(() => remove({ id: item.id }))
      .then(() => {
        toast.show("Sending again when the session is idle");
        return invalidate();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setResending(null));
  }

  function onClear() {
    void clear({})
      .then(({ removed }) => {
        toast.show(removed === 1 ? "Cleared 1 message from activity" : `Cleared ${removed} messages from activity`);
        return invalidate();
      })
      .catch((error: unknown) => toast.error(errorText(error)));
  }

  // Older hosts leave `navigation` undefined, so the link is plain text there.
  const openSession = navigation === undefined
    ? undefined
    : (item: Deferred) => navigation.openAgent({ agentId: item.agentId });

  // Group headings in schedule order: the list is already sorted by due time,
  // so each heading appears where its first message does.
  const groups: { key: string; label: string; items: Deferred[] }[] = [];
  for (const item of pending) {
    const group = dayGroup(item, now);
    const existing = groups.find((candidate) => candidate.key === group.key);
    if (existing) existing.items.push(item);
    else groups.push({ ...group, items: [item] });
  }

  const held = pending.filter((item) => isOverdue(item, now)).length;
  const next = pending.find((item) => item.dueAt !== null && !isOverdue(item, now) && item.state === "pending");
  const summary = [
    next === undefined || next.dueAt === null ? "" : `Next ${formatClock(next.dueAt)} · ${formatCountdown(next.dueAt, now)}`,
    held === 0 ? "" : `${held} held for a busy agent`,
    resetsAt === null ? "" : `Session resets ${formatResetLabel(resetsAt)}${usedPct === null ? "" : ` (${Math.round(usedPct)}% used)`}`,
  ].filter((part) => part !== "");

  const loading = queue.isLoading && queue.data === undefined;
  const activity = allActivity ? settled : settled.slice(0, ACTIVITY_LIMIT);
  const counts = ([["Sent", "success"], ["Cancelled", "muted"], ["Failed", "danger"]] as const)
    .map(([verb, tone]) => [verb, settled.filter((item) => describeActivity(item)?.verb === verb).length, tone] as const)
    .filter(([, count]) => count > 0);

  const sessionPicker = (
    <View style={{ gap: 8 }}>
      <Text style={t.group}>To</Text>
      {rows.length > FILTER_THRESHOLD ? (
        <TextInput
          style={styles.field}
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter sessions…"
          placeholderTextColor={c.foregroundMuted}
          accessibilityLabel="Filter sessions"
        />
      ) : null}
      {sessionList.isError ? <Text style={styles.danger}>Couldn't read the session list. {errorText(sessionList.error)}</Text> : null}
      {!sessionList.isError && sessionList.isSuccess && rows.length === 0 ? (
        <Text style={styles.hint}>No open sessions to defer to yet.</Text>
      ) : null}
      <View style={{ borderRadius: 10, borderWidth: 1, borderColor: c.border, overflow: "hidden" }}>
        {visible.map((session, index) => {
          const on = session.id === targetId;
          return (
            <Pressable
              key={session.id}
              accessibilityRole="radio"
              accessibilityLabel={`Defer to ${sessionTitle(session)}`}
              accessibilityState={{ selected: on, checked: on }}
              onPress={() => setTargetId(on ? null : session.id)}
              style={(state: PressState) => ({
                flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, minHeight: compact ? 52 : 44, paddingVertical: 7,
                borderTopWidth: index === 0 ? 0 : 1, borderTopColor: c.border,
                backgroundColor: on ? c.surface2 : state.pressed ? c.surface2 : state.hovered ? c.surface1 : "transparent",
              })}
            >
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: session.status === "running" ? c.statusSuccess : session.status === "error" ? c.statusDanger : withAlpha(c.foregroundMuted, 0.5) }} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={[t.body, on ? { fontWeight: "600" } : null]}>{sessionTitle(session)}</Text>
                <Text numberOfLines={1} style={t.small}>
                  {[workspaceOf(session), session.status === "running" ? "working" : session.status].filter((part) => part !== "").join(" · ")}
                </Text>
              </View>
              {on ? <Icon name="Check" size={16} color={c.foreground} /> : null}
            </Pressable>
          );
        })}
      </View>
      {hidden > 0 ? <Text style={styles.hint}>{`${hidden} more ${hidden === 1 ? "session" : "sessions"}. Type to filter.`}</Text> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 32, paddingBottom: 48, alignItems: "center" }}>
        <View style={{ width: "100%", maxWidth: 760, gap: compact ? 18 : 22 }}>
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: compact ? 19 : 22, lineHeight: compact ? 25 : 29, fontWeight: "600", ...tabular }}>
                {loading ? "Deferred messages" : pending.length === 0 ? "Nothing waiting" : pending.length === 1 ? "1 message waiting" : `${pending.length} messages waiting`}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Button theme={theme} compact={compact} icon="Plus" title={compact ? "New" : "New message"} accessibilityLabel="Defer a new message" onPress={() => { setEditingId(null); setComposing(true); }} />
                {openSettings === undefined ? null : <IconButton theme={theme} compact={compact} icon="Settings" label="Defer settings" onPress={openSettings} />}
              </View>
            </View>
            {summary.length > 0 ? <Text style={[t.meta, { fontSize: 13, lineHeight: 19 }]}>{summary.join(" · ")}</Text> : null}
          </View>

          {queue.isError && queue.data === undefined ? (
            <Card theme={theme} style={{ padding: 16, gap: 10 }}>
              <Text style={t.label}>Couldn't read the queue</Text>
              <Text style={t.meta}>{errorText(queue.error)}</Text>
              <Button theme={theme} compact={compact} icon="RotateCw" title="Try again" onPress={() => void queue.refetch()} />
            </Card>
          ) : loading ? (
            <Card theme={theme} style={{ padding: 16, gap: 18 }}>
              {[0, 1, 2].map((index) => (
                <View key={index} style={{ gap: 8 }}>
                  <Skeleton width={120} height={12} color={c.surface2} />
                  <Skeleton width="80%" height={10} color={c.surface2} />
                </View>
              ))}
            </Card>
          ) : pending.length === 0 ? (
            <Card theme={theme} style={{ padding: compact ? 16 : 20, gap: 10 }}>
              <Text style={t.label}>Queue a message for later</Text>
              <Text style={[t.body, { color: c.foregroundMuted }]}>
                Press Defer above a session's message box, or type a time before your message:
              </Text>
              <View style={{ alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: c.surface2 }}>
                <Text selectable style={{ color: c.foreground, fontFamily: "monospace", fontSize: 13 }}>/defer 2h ship the release notes</Text>
              </View>
              <Text style={t.meta}>It sends after the wait, at a time, or when your usage window resets, and only once the agent is idle.</Text>
            </Card>
          ) : (
            groups.map((group) => (
              <View key={group.key} style={{ gap: 8 }}>
                <GroupLabel theme={theme} label={group.label} count={group.items.length} />
                <Card theme={theme} style={{ paddingHorizontal: compact ? 14 : 16 }}>
                  {group.items.map((item, index) => (
                    <View key={item.id} style={index === 0 ? undefined : { borderTopWidth: 1, borderTopColor: c.border }}>
                      <DeferredRow
                        styles={styles}
                        item={item}
                        meta={labelFor(item.agentId)}
                        now={now}
                        editing={editingId === item.id}
                        onEdit={(target) => { setComposing(false); setTargetId(target.agentId); setEditingId(target.id); }}
                        onSendNow={send.sendNow}
                        scheduling={send.isPending(item.id)}
                        onSnooze={onSnooze}
                        onCancel={onCancel}
                        onOpenSession={openSession}
                      />
                    </View>
                  ))}
                </Card>
              </View>
            ))
          )}

          {settled.length > 0 ? (
            <View style={{ gap: 8, marginTop: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <GroupLabel theme={theme} label="Recent activity" />
                <Text style={[t.small, { flex: 1 }]} numberOfLines={1}>
                  {counts.map(([verb, count, tone], index) => (
                    <Text key={verb} style={{ color: toneColor(c, tone) }}>{`${index === 0 ? "" : " · "}${count} ${verb.toLowerCase()}`}</Text>
                  ))}
                </Text>
                <Button theme={theme} kind="ghost" small compact={compact} title="Clear" accessibilityLabel="Clear sent, cancelled and failed messages" onPress={onClear} />
              </View>
              <Card theme={theme}>
                {activity.map((item, index) => {
                  const entry = describeActivity(item);
                  if (entry === null) return null;
                  const at = item.settledAt ?? item.createdAt;
                  return (
                    <View key={item.id} style={{ flexDirection: "row", gap: compact ? 12 : 16, paddingHorizontal: compact ? 14 : 16, paddingVertical: 11, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: c.border }}>
                      <View style={{ width: compact ? 62 : 72 }}>
                        <Text style={[t.body, tabular]}>{formatClock(at)}</Text>
                        <Text style={t.small}>{formatDay(at, now)}</Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text style={t.body} numberOfLines={2}>
                          <Text style={{ color: toneColor(c, entry.tone), fontWeight: "600" }}>{entry.verb}</Text>
                          {entry.detail === "" ? "" : <Text style={{ color: c.foregroundMuted }}>{` · ${entry.detail}`}</Text>}
                        </Text>
                        <Text style={[t.meta, { color: c.foreground }]} numberOfLines={1}>{item.text}</Text>
                        {labelFor(item.agentId) === "" ? null : <Text style={t.small} numberOfLines={1}>{labelFor(item.agentId)}</Text>}
                        {item.state === "failed" && byId.has(item.agentId) ? (
                          <View style={{ marginTop: 6 }}>
                            {rowActions({
                              theme, compact, disabled: resending === item.id,
                              resend: { label: "Send this message again", title: resending === item.id ? "Sending…" : "Send again", onPress: () => onResend(item) },
                            })}
                          </View>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
                {settled.length > ACTIVITY_LIMIT ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={allActivity ? "Show less activity" : "Show all activity"} onPress={() => setAllActivity((value) => !value)}
                    style={(state: PressState) => ({ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, minHeight: compact ? 44 : 36, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.hovered ? c.surface1 : "transparent" })}>
                    <Text style={t.meta}>{allActivity ? "Show less" : `Show all ${settled.length}`}</Text>
                    <Icon name={allActivity ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
                  </Pressable>
                ) : null}
              </Card>
            </View>
          ) : null}
        </View>
      </ScrollView>

      <Modal title="New deferred message" open={composing} onOpenChange={(open) => { setComposing(open); if (!open) setTargetId(null); }}>
        <Modal.Content>
          <View style={{ gap: 16, width: compact ? undefined : 480, maxWidth: "100%" }}>
            {sessionPicker}
            <DeferComposer
              theme={theme}
              styles={styles}
              agentId={targetId}
              resetsAt={targetId === null ? null : resetsAt}
              usedPct={targetId === null ? null : usedPct}
              usageError={queue.data?.usageError ?? null}
              editing={null}
              onEditingChange={() => {}}
              onSaved={invalidate}
              onCreated={(item) => { toast.show(queuedLabel(item)); setComposing(false); setTargetId(null); }}
            />
          </View>
        </Modal.Content>
      </Modal>

      <Modal title="Edit deferred message" open={editing !== null} onOpenChange={(open) => { if (!open) { setEditingId(null); setTargetId(null); } }}>
        <Modal.Content>
          <View style={{ gap: 12, width: compact ? undefined : 480, maxWidth: "100%" }}>
            {editing === null ? null : <Text style={t.meta} numberOfLines={1}>{`To ${labelFor(editing.agentId) || "this session"}`}</Text>}
            <DeferComposer
              theme={theme}
              styles={styles}
              agentId={editing?.agentId ?? null}
              resetsAt={resetsAt}
              usedPct={usedPct}
              usageError={queue.data?.usageError ?? null}
              editing={editing}
              onEditingChange={(item) => setEditingId(item?.id ?? null)}
              onSaved={invalidate}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
