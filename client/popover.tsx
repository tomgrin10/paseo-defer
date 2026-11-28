import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { cancelDeferred, listDeferred, updateDeferred, type Deferred } from "../shared/defer";
import { DeferComposer, DeferredRow, deferStyles } from "./composer";
import { offerComposerDraft } from "./handoff";
import { Button, errorText, GroupLabel, tickFor, useNow } from "./kit";
import { notifyDeferChanged } from "./refresh";
import { useSendNow } from "./send-now";
import { byDueAt, formatClock, queuedLabel, snoozeTrigger } from "../shared/format";

/**
 * The composer pill's popover: the same message box and timing controls as the
 * full Defer panel, anchored to the pill instead of opening a tab, with this
 * session's queue underneath. Paseo owns the popover chrome (positioning,
 * dismissal, scrolling; a bottom sheet on phones) through `behavior: { kind:
 * "popover" }` on the composer pill's button descriptor.
 *
 * Only ever registered on the composer pill, which is always agent-context;
 * the header-button variant of `PluginButtonContentProps` is not reachable
 * here, so the union is narrowed once at the boundary rather than after hooks.
 */
export function DeferPopoverContent(props: PluginButtonContentProps & { openQueue?: () => void }) {
  if (props.context !== "agent") return null;
  return <DeferPopoverBody theme={props.theme} layout={props.layout} agentId={props.agentId} close={props.close} openQueue={props.openQueue} />;
}

interface DeferPopoverBodyProps {
  theme: PluginHostProps["theme"];
  layout: PluginHostProps["layout"];
  agentId: string;
  close(): void;
  openQueue?: (() => void) | undefined;
  /**
   * Drawn inside Paseo's `Modal` (the 0.16 composer control), whose own header
   * carries the title: no heading row, and the way to every queue sits last.
   */
  inDialog?: boolean | undefined;
  /** Told when a waiting row opens in the composer or closes, so a dialog can retitle itself. */
  onEditingChange?: ((editing: boolean) => void) | undefined;
}

export function DeferPopoverBody({ theme, layout, agentId, close, openQueue, inDialog = false, onEditingChange }: DeferPopoverBodyProps) {
  const list = useRpc(listDeferred);
  const cancel = useRpc(cancelDeferred);
  const update = useRpc(updateDeferred);
  const toast = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["defer-popover", agentId];

  const [editingId, setEditingId] = useState<string | null>(null);

  // Offered once as this popover mounts, so a prompt already typed in the
  // session's own composer is in the message box by the time it can be seen.
  // `DeferComposer`'s own effect subscribes before this one runs (children
  // commit before parents), so the offer is delivered directly.
  useEffect(() => {
    offerComposerDraft(agentId);
  }, [agentId]);

  const queue = useQuery({
    queryKey,
    queryFn: () => list({ agentId }),
    refetchInterval: 10_000,
  });

  const invalidate = () => {
    notifyDeferChanged();
    return queryClient.invalidateQueries({ queryKey });
  };
  const send = useSendNow(invalidate);
  const styles = useMemo(() => deferStyles(theme, layout), [theme, layout]);
  const c = theme.colors;

  const items = queue.data?.items ?? [];
  const pending = byDueAt(items.filter((item) => item.state === "pending" || item.state === "sending"));
  const editing = pending.find((item) => item.id === editingId) ?? null;
  const isEditing = editing !== null;
  useEffect(() => {
    onEditingChange?.(isEditing);
  }, [isEditing, onEditingChange]);
  const now = useNow(tickFor(pending, Date.now()));

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

  // Queueing from the popover has nowhere else to go: put the popover away and
  // let the toast carry the confirmation.
  function onCreated(item: Deferred) {
    toast.show(queuedLabel(item));
    close();
  }

  const compact = layout.compact;
  const headed = !compact && !inDialog;
  return (
    <View style={{ width: compact || inDialog ? undefined : 400, maxWidth: "100%", gap: 12 }}>
      {!headed ? null : (
        // On phones the sheet already carries the button's title.
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 28 }}>
          <Text accessibilityRole="header" style={styles.heading}>
            {editing === null ? "Defer a message" : "Edit deferred message"}
          </Text>
          {openQueue === undefined ? null : (
            <Button theme={theme} kind="ghost" small title="All deferred" icon="ArrowUpRight" onPress={() => { close(); openQueue(); }} />
          )}
        </View>
      )}

      <DeferComposer
        theme={theme}
        styles={styles}
        agentId={agentId}
        resetsAt={queue.data?.sessionResetsAt ?? null}
        usedPct={queue.data?.sessionUsedPct ?? null}
        usageError={queue.data?.usageError ?? null}
        editing={editing}
        onEditingChange={(item) => setEditingId(item?.id ?? null)}
        onSaved={invalidate}
        onCreated={onCreated}
        acceptComposerDraft
      />

      {pending.length > 0 ? (
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 }}>
          <GroupLabel theme={theme} label="Waiting" count={pending.length} />
          {pending.map((item, index) => (
            <View key={item.id} style={index === 0 ? undefined : { borderTopWidth: 1, borderTopColor: c.border }}>
              <DeferredRow
                styles={styles}
                item={item}
                meta=""
                now={now}
                editing={editingId === item.id}
                onEdit={(target) => setEditingId(target.id)}
                onSendNow={send.sendNow}
                scheduling={send.isPending(item.id)}
                onSnooze={onSnooze}
                onCancel={onCancel}
              />
            </View>
          ))}
        </View>
      ) : null}

      {inDialog && !compact && openQueue !== undefined ? (
        // Desktop dialog: Defer stays the only full-width bar; the way to every
        // queue is a quiet link at the foot.
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Button theme={theme} kind="ghost" small title="All deferred" icon="ArrowUpRight" onPress={() => { close(); openQueue(); }} />
        </View>
      ) : null}

      {compact && openQueue !== undefined ? (
        <Button theme={theme} kind="secondary" compact={compact} grow title="All deferred messages" icon="ArrowUpRight" onPress={() => { close(); openQueue(); }} />
      ) : null}
    </View>
  );
}
