import type { Deferred } from "../shared/defer";

/** Context attachments reach the provider alongside the original message text. */
export function deferralOptions(item: Deferred, sentAt: string) {
  return {
    messageId: item.id,
    attachments: [{
      type: "text" as const,
      mimeType: "text/plain" as const,
      contextKind: "paseo-defer",
      title: "Deferral details",
      text: JSON.stringify({
        version: 1,
        plugin: "paseo-defer",
        deferredMessageId: item.id,
        deferredAt: item.createdAt,
        scheduledFor: item.dueAt,
        trigger: item.trigger,
        usageWindowResetsAt: item.anchorResetsAt,
        sentAt,
        waitedMs: Math.max(0, Date.parse(sentAt) - Date.parse(item.createdAt)),
        lateByMs: item.dueAt === null ? null : Math.max(0, Date.parse(sentAt) - Date.parse(item.dueAt)),
      }),
    }],
  };
}
