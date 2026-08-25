import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  cancelDeferred,
  clearSettled,
  listDeferred,
  listSessions,
  type Deferred,
  type Session,
} from "./defer.shared";
import { DeferComposer, DeferredRow, deferStyles } from "./composer.client";
import { formatClock, formatRelative, stateLabel } from "./format.shared";

const FILTER_THRESHOLD = 6;
/** A busy daemon lists dozens of sessions; the filter reaches past this many. */
const PICKER_LIMIT = 12;

function sessionTitle(session: Session): string {
  const title = session.title?.trim() ?? "";
  return title === "" ? "Untitled session" : title;
}

function sessionMeta(session: Session): string {
  return [session.workspaceLabel ?? "", session.status, session.id]
    .filter((part) => part !== "")
    .join(" · ");
}

export function DeferOverview({ theme, layout }: PluginSurfaceProps) {
  const list = useRpc(listDeferred);
  const sessions = useRpc(listSessions);
  const cancel = useRpc(cancelDeferred);
  const clear = useRpc(clearSettled);
  const queryClient = useQueryClient();
  const queryKey = ["defer", "all"];

  const [targetId, setTargetId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const queue = useQuery({ queryKey, queryFn: () => list({}), refetchInterval: 10_000 });
  const sessionList = useQuery({
    queryKey: ["defer", "sessions"],
    queryFn: () => sessions({}),
    refetchInterval: 15_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });
  const styles = useMemo(() => deferStyles(theme, layout), [theme, layout]);

  const items = queue.data?.items ?? [];
  const pending = items.filter((item) => item.state === "pending" || item.state === "sending");
  const settled = items.filter((item) => item.state !== "pending" && item.state !== "sending");
  const resetsAt = queue.data?.sessionResetsAt ?? null;
  const editing = items.find((item) => item.id === editingId) ?? null;

  const rows = sessionList.data?.sessions ?? [];
  const byId = useMemo(() => new Map(rows.map((session) => [session.id, session])), [rows]);
  const needle = filter.trim().toLowerCase();
  const matching =
    needle === ""
      ? rows
      : rows.filter((session) =>
          `${sessionTitle(session)} ${session.workspaceLabel ?? ""} ${session.id}`
            .toLowerCase()
            .includes(needle),
        );
  const visible = matching.slice(0, PICKER_LIMIT);
  const hidden = matching.length - visible.length;

  /** How a queued message names the session it will land in. */
  function labelFor(agentId: string): string {
    const session = byId.get(agentId);
    return session === undefined
      ? `unknown session ${agentId.slice(0, 8)}`
      : sessionTitle(session);
  }

  function onCancel(item: Deferred) {
    if (editingId === item.id) setEditingId(null);
    void cancel({ id: item.id }).then(invalidate);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <Text style={styles.title}>Deferred messages</Text>
      <Text style={styles.hint}>
        {resetsAt === null
          ? "Usage window unavailable."
          : `Session resets ${formatClock(resetsAt)} (${formatRelative(resetsAt)}).`}
      </Text>

      <Text style={styles.section}>{editing === null ? "Defer to a session" : "Edit deferred message"}</Text>

      {editing === null ? (
        <>
          {rows.length > FILTER_THRESHOLD ? (
            <TextInput
              style={styles.filter}
              value={filter}
              onChangeText={setFilter}
              placeholder="Filter sessions…"
              placeholderTextColor={theme.colors.foregroundMuted}
              accessibilityLabel="Filter sessions"
            />
          ) : null}

          {sessionList.isError ? (
            <Text style={styles.danger}>Could not read the session list.</Text>
          ) : null}
          {!sessionList.isError && rows.length === 0 ? (
            <Text style={styles.hint}>No open sessions to defer to yet.</Text>
          ) : null}

          <View style={styles.row}>
            {visible.map((session) => {
              const on = session.id === targetId;
              return (
                <Pressable
                  key={session.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Defer to ${sessionTitle(session)}`}
                  accessibilityState={{ selected: on }}
                  onPress={() => setTargetId(on ? null : session.id)}
                  style={[styles.sessionChip, on ? styles.chipOn : null]}
                >
                  <Text style={on ? styles.chipTextOn : styles.chipText} numberOfLines={1}>
                    {sessionTitle(session)}
                  </Text>
                  <Text style={on ? styles.chipTextOn : styles.targetMeta} numberOfLines={1}>
                    {sessionMeta(session)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {hidden > 0 ? (
            <Text style={styles.hint}>{`${hidden} more session(s) — type to filter.`}</Text>
          ) : null}

          <Text style={styles.hint}>
            {targetId === null
              ? "Pick the session this message should land in."
              : `Sending to ${labelFor(targetId)} · ${targetId}`}
          </Text>
        </>
      ) : (
        <Text style={styles.hint}>{`Editing a message for ${labelFor(editing.agentId)} · ${editing.agentId}`}</Text>
      )}

      <DeferComposer
        theme={theme}
        styles={styles}
        agentId={targetId}
        resetsAt={resetsAt}
        usageError={queue.data?.usageError ?? null}
        editing={editing}
        onEditingChange={(item) => setEditingId(item?.id ?? null)}
        onSaved={invalidate}
      />

      <Text style={styles.section}>{`Waiting (${pending.length})`}</Text>
      {pending.length === 0 ? <Text style={styles.hint}>Nothing deferred.</Text> : null}
      {pending.map((item) => (
        <DeferredRow
          key={item.id}
          styles={styles}
          item={item}
          meta={`${stateLabel(item)} · ${labelFor(item.agentId)}`}
          editing={editingId === item.id}
          onEdit={(target) => setEditingId(target.id)}
          onCancel={onCancel}
        />
      ))}

      {settled.length > 0 ? (
        <>
          <View style={styles.row}>
            <Text style={styles.section}>{`History (${settled.length})`}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear delivered and failed messages"
              onPress={() => {
                void clear({}).then(invalidate);
              }}
            >
              <Text style={styles.link}>Clear</Text>
            </Pressable>
          </View>
          {settled.map((item) => (
            <View key={item.id} style={styles.item}>
              <Text style={styles.itemMeta} numberOfLines={1}>
                {item.text}
              </Text>
              <Text style={item.state === "failed" ? styles.danger : styles.itemMeta}>
                {`${stateLabel(item)} · ${labelFor(item.agentId)}`}
              </Text>
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}
