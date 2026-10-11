import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { listTimelineDeferred } from "../shared/defer";
import { DEFER_TIMELINE_KIND } from "../shared/timeline";
import { onDeferChanged } from "./refresh";
import { DeferredMessage } from "./timeline";

type FooterProps = PluginHostProps & { agentId: string };
type FooterClient = PluginClientContext & {
  addTimelineFooter?: (contribution: {
    id: string;
    replaces: { kind: string; version: number }[];
    Component: typeof DeferredTimelineFooter;
  }) => () => void;
};

export function DeferredTimelineFooter(props: FooterProps) {
  const list = useRpc(listTimelineDeferred);
  const queue = useQuery({ queryKey: ["defer-timeline", props.host.id, props.agentId], queryFn: () => list({ agentId: props.agentId }), refetchInterval: 10_000 });
  useEffect(() => onDeferChanged(() => { void queue.refetch(); }), [queue.refetch]);
  const items = queue.data?.items ?? [];
  if (items.length === 0 && !queue.error) return null;
  return (
    <View style={{ gap: 8 }}>
      {items.map(item => item.state === "pending" || item.state === "sending" || item.state === "failed" ? (
        <DeferredMessage key={item.id} {...props} timestamp={new Date(item.createdAt)} item={{ type: "plugin", kind: DEFER_TIMELINE_KIND, version: 1, data: {
          ...item, state: item.state, text: item.text.length > 2000 ? `${item.text.slice(0, 2000)}…` : item.text,
        } }} />
      ) : null)}
      {queue.error ? (
        <View style={{ gap: 4, padding: 12 }}>
          <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger }}>Could not refresh deferred messages.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry deferred messages" onPress={() => void queue.refetch()}>
            <Text style={{ color: props.theme.colors.foreground }}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export function contributePinnedTimeline(client: FooterClient) {
  // The footer API is supplied by the Paseo app; earlier apps keep inline cards.
  client.addTimelineFooter?.({ id: "deferred-messages", replaces: [{ kind: DEFER_TIMELINE_KIND, version: 1 }], Component: DeferredTimelineFooter });
}
