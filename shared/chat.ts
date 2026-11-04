import { z } from "zod";

/**
 * Defer's agent tools as they appear in a chat, reduced to what a one-line row
 * needs. Pure, so both the transformer and the checks read the same rules.
 */
export const TOOL_ROW_KIND = "defer-tool-row";

export const ToolRowSchema = z.object({
  tool: z.enum(["schedule", "list"]),
  state: z.enum(["running", "done", "failed"]),
  /** schedule: when it sends; null for a reset that is not known yet. */
  dueAt: z.string().nullable(),
  reset: z.boolean(),
  /** schedule: the message the agent queued for itself. */
  text: z.string(),
  /** list: what is waiting, soonest first. */
  items: z.array(z.object({ dueAt: z.string().nullable(), text: z.string(), state: z.string() })),
  error: z.string(),
});
export type ToolRow = z.infer<typeof ToolRowSchema>;

const TOOL = /(?:^|__|\.|\/|:)(defer_schedule_message|defer_list_messages)$/;

/** `mcp__paseo__defer_schedule_message` (Claude), `paseo.defer_list_messages` (Codex), or bare. */
export function deferToolName(name: string): ToolRow["tool"] | null {
  const match = TOOL.exec(name);
  if (!match) return null;
  return match[1] === "defer_schedule_message" ? "schedule" : "list";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text a tool result carries, however the provider wrapped it. */
export function readText(value: unknown): string | undefined {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((part) => typeof part === "string" ? part : record(part) && typeof part.text === "string" ? part.text : undefined);
    return parts.every((part) => part !== undefined) ? parts.join("\n") : undefined;
  }
  if (!record(value)) return undefined;
  if (record(value.structuredContent)) return JSON.stringify(value.structuredContent);
  const key = ["output", "content", "text", "message", "result"].find((name) => name in value);
  return key ? readText(value[key]) : undefined;
}

function json(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try { const value: unknown = JSON.parse(text); return record(value) ? value : null; } catch { return null; }
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Builds a row from a tool call, or null when the call is not one of Defer's. */
export function toolRow(name: string, status: string, detail: unknown, error: unknown): ToolRow | null {
  const tool = deferToolName(name);
  if (tool === null) return null;
  const input = record(detail) && record(detail.input) ? detail.input : {};
  const output = json(record(detail) && "output" in detail ? readText(detail.output) : undefined);
  const failedOutput = record(detail) && record(detail.output) && detail.output.isError === true;
  const state: ToolRow["state"] = status === "failed" || failedOutput ? "failed" : status === "completed" ? "done" : "running";
  const trigger = record(input.trigger) ? input.trigger : {};
  const listed = output !== null && Array.isArray(output.items) ? output.items.filter(record) : [];
  return {
    tool,
    state,
    dueAt: output !== null && typeof output.dueAt === "string" ? output.dueAt : null,
    reset: trigger.kind === "sessionReset",
    text: str(input.text).slice(0, 4000),
    items: listed.slice(0, 20).map((item) => ({
      dueAt: typeof item.dueAt === "string" ? item.dueAt : null,
      text: str(item.text).slice(0, 400),
      state: str(item.state),
    })),
    error: state === "failed" ? (readText(error) || (record(detail) ? readText(detail.output) : "") || "").slice(0, 500) : "",
  };
}
