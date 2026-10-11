import { z } from "zod";
import { DeferredSchema } from "./defer";

export const DEFER_TIMELINE_KIND = "deferred-message";
export const DeferTimelineSchema = z.union([
  z.object({ state: z.literal("settled") }),
  DeferredSchema.pick({ id: true, text: true, trigger: true, dueAt: true, createdAt: true }).extend({
    state: z.enum(["pending", "sending", "failed"]),
  }),
]);
export type DeferTimelineData = z.infer<typeof DeferTimelineSchema>;
