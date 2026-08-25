import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/** How a deferred message decides it is due. */
export const TriggerSchema = z.discriminatedUnion("kind", [
  /** Fire once, `ms` after it was created. */
  z.object({ kind: z.literal("after"), ms: z.number().int().positive() }),
  /** Fire once, at an absolute instant the client already resolved. */
  z.object({ kind: z.literal("at"), iso: z.string() }),
  /** Fire when the provider's rolling usage window rolls over. */
  z.object({ kind: z.literal("sessionReset") }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const DeferredStateSchema = z.enum(["pending", "sending", "sent", "failed", "cancelled"]);
export type DeferredState = z.infer<typeof DeferredStateSchema>;

export const DeferredSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  trigger: TriggerSchema,
  /** Absolute due instant. Null only while a sessionReset anchor is unknown. */
  dueAt: z.string().nullable(),
  /** The window reset we were told about when this was created. */
  anchorResetsAt: z.string().nullable(),
  createdAt: z.string(),
  state: DeferredStateSchema,
  settledAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type Deferred = z.infer<typeof DeferredSchema>;

/** A session a message can be deferred to, as shown in the picker. */
export const SessionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  status: z.string(),
  workspaceLabel: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

export const listSessions = defineRpc({
  name: "defer.sessions",
  input: z.object({}),
  output: z.object({ sessions: z.array(SessionSchema) }),
});

export const listDeferred = defineRpc({
  name: "defer.list",
  input: z.object({ agentId: z.string().optional() }),
  output: z.object({
    items: z.array(DeferredSchema),
    /** Next provider window reset, so the UI can label the sessionReset option. */
    sessionResetsAt: z.string().nullable(),
    usageError: z.string().nullable(),
  }),
});

export const createDeferred = defineRpc({
  name: "defer.create",
  input: z.object({
    agentId: z.string(),
    text: z.string().min(1),
    trigger: TriggerSchema,
  }),
  output: z.object({ item: DeferredSchema }),
});

export const updateDeferred = defineRpc({
  name: "defer.update",
  input: z.object({
    id: z.string(),
    text: z.string().min(1).optional(),
    /** Omit to keep the existing timing; sending one re-anchors relative triggers. */
    trigger: TriggerSchema.optional(),
  }),
  output: z.object({ item: DeferredSchema.nullable(), error: z.string().nullable() }),
});

export const cancelDeferred = defineRpc({
  name: "defer.cancel",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const clearSettled = defineRpc({
  name: "defer.clear-settled",
  input: z.object({ agentId: z.string().optional() }),
  output: z.object({ removed: z.number() }),
});
