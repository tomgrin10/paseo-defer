import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as uiApi from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import type { Deferred } from "../shared/defer";
import { deferredTitle, pillLabel } from "../shared/format";
import { useNow } from "./kit";
import { useLiveQueue, type LiveQueue } from "./live";

/**
 * Paseo 0.17.1's workspace-row badge: on each sidebar workspace row, the
 * messages waiting for that workspace's sessions ("2 · 4:42 PM", "in 12m"),
 * in the same words as the composer pill. Nothing when none wait.
 *
 * It reads the live queue the pill's poll already publishes, placed by the
 * agent stream the pill already follows, so it adds no poll and no request.
 * Hiding it is the host's own Show menu toggle (the contribution's `title`).
 */

interface RowBadgeProps {
  icon?: string;
  label?: string;
  tone?: "muted" | "success" | "warning" | "danger" | "info";
  accessibilityLabel?: string;
}
interface RowBadgeItemProps {
  workspaceId: string;
}
type RowBadgeHost = {
  addWorkspaceRowBadgeItem(contribution: {
    id: string;
    title: string;
    icon: string;
    Component: ComponentType<RowBadgeItemProps>;
  }): () => void;
};

/** The id and Show-menu title the host lists the badge under. */
export const ROW_BADGE_ID = "deferred";
export const ROW_BADGE_TITLE = "Deferred messages";

/** Whether this host draws workspace-row badges (Paseo 0.17.1 and later). */
export function supportsRowBadge(client: PluginClientContext): boolean {
  return (
    typeof (client as unknown as Partial<RowBadgeHost>).addWorkspaceRowBadgeItem === "function" &&
    typeof (uiApi as unknown as { WorkspaceRowBadge?: unknown }).WorkspaceRowBadge !== "undefined"
  );
}

/** Registers the badge on a host that has one; on older hosts does nothing. */
export function contributeRowBadge(client: PluginClientContext, live: LiveQueue): () => void {
  if (!supportsRowBadge(client)) return () => undefined;
  const Badge = (uiApi as unknown as { WorkspaceRowBadge: ComponentType<RowBadgeProps> }).WorkspaceRowBadge;

  /** Only mounted while something waits, so an idle row runs no clock. */
  function Waiting({ items }: { items: readonly Deferred[] }) {
    const now = useNow(30_000);
    return <Badge icon="Clock" label={pillLabel(items, now)} tone="muted" accessibilityLabel={deferredTitle(items, now)} />;
  }

  function DeferredRowBadge({ workspaceId }: RowBadgeItemProps) {
    useLiveQueue(live);
    const items = live.forWorkspace(workspaceId);
    return items.length === 0 ? null : <Waiting items={items} />;
  }

  const remove = (client as unknown as RowBadgeHost).addWorkspaceRowBadgeItem({
    id: ROW_BADGE_ID,
    title: ROW_BADGE_TITLE,
    icon: "Clock",
    Component: DeferredRowBadge,
  });
  return () => {
    if (typeof remove === "function") remove();
  };
}
