import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { cancelDeferred, listDeferred, updateDeferred, type Deferred } from "../shared/defer";
import { DeferComposer, DeferredRow, deferStyles } from "./composer";
import { offerComposerDraft } from "./handoff";
import { notifyDeferChanged } from "./refresh";
import { queuedLabel, stateLabel } from "../shared/format";

/**
 * The composer pill's popover: the same message box and timing controls as the
 * full Defer panel, anchored to the pill instead of opening a tab. Paseo owns
 * the popover chrome (positioning, dismissal, scrolling) through `behavior:
 * { kind: "popover" }` on the composer pill's button descriptor — this
 * component is only ever mounted inside that host-drawn surface.
 *
 * Only ever registered on the composer pill, which is always agent-context;
 * the header-button variant of `PluginButtonContentProps` is not reachable
 * here, so the union is narrowed once at the boundary rather than after hooks.
 */
export function DeferPopoverContent(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return <DeferPopoverBody theme={props.theme} layout={props.layout} agentId={props.agentId} close={props.close} />;
}

interface DeferPopoverBodyProps {
  theme: PluginHostProps["theme"];
  layout: PluginHostProps["layout"];
  agentId: string;
  close(): void;
}

function DeferPopoverBody({ theme, layout, agentId, close }: DeferPopoverBodyProps) {
  const list = useRpc(listDeferred);
  const cancel = useRpc(cancelDeferred);
  const update = useRpc(updateDeferred);
  const toast = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["defer-popover", agentId];

  const [editingId, setEditingId] = useState<string | null>(null);

  // Mirrors the old panel-opening call site: offered once as this popover
  // mounts, so a prompt already typed in the session's own composer is already
  // in the message box below by the time it can be seen. `DeferComposer`'s own
  // effect subscribes before this one runs (children commit before parents),
  // so the offer is delivered directly rather than through the fallback buffer.
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
  const styles = useMemo(() => deferStyles(theme, layout), [theme, layout]);

  const items = queue.data?.items ?? [];
  const pending = items.filter((item) => item.state === "pending" || item.state === "sending");
  const editing = pending.find((item) => item.id === editingId) ?? null;

  function onSendNow(item: Deferred) {
    void update({ id: item.id, trigger: { kind: "at", iso: new Date().toISOString() } })
      .then((result) => {
        if (result.item === null) throw new Error(result.error ?? "Could not send this deferred message.");
        toast.show("Sending now");
        return invalidate();
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }

  function onCancel(item: Deferred) {
    if (editingId === item.id) setEditingId(null);
    void cancel({ id: item.id })
      .then(() => {
        toast.show("Deferred message cancelled");
        return invalidate();
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }

  // Queueing from the popover has nowhere else to go: put the composer away and
  // let the toast carry the confirmation, same message the full panel shows.
  function onCreated(item: Deferred) {
    toast.show(queuedLabel(item));
    close();
  }

  return (
    <View style={{ gap: 10 }}>
      {pending.length > 0 ? (
        <View style={{ gap: 0 }}>
          {pending.map((item) => (
            <DeferredRow
              key={item.id}
              styles={styles}
              item={item}
              meta={stateLabel(item)}
              editing={editingId === item.id}
              onEdit={(target) => setEditingId(target.id)}
              onSendNow={onSendNow}
          onCancel={onCancel}
            />
          ))}
        </View>
      ) : null}

      <DeferComposer
        theme={theme}
        styles={styles}
        agentId={agentId}
        resetsAt={queue.data?.sessionResetsAt ?? null}
        usageError={queue.data?.usageError ?? null}
        editing={editing}
        onEditingChange={(item) => setEditingId(item?.id ?? null)}
        onSaved={invalidate}
        onCreated={onCreated}
        acceptComposerDraft
      />
    </View>
  );
}
