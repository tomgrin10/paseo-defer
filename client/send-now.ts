import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useRef, useState } from "react";
import { updateDeferred, type Deferred } from "../shared/defer";

/** Reschedule the existing row; the scheduler still owns idle-only delivery. */
export function useSendNow(
  refresh: () => unknown | Promise<unknown>,
  onError?: (message: string | null) => void,
) {
  const update = useRpc(updateDeferred);
  const toast = useToast();
  const active = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const reportError = (message: string) => onError ? onError(message) : toast.error(message);

  async function sendNow(item: Pick<Deferred, "id" | "state">) {
    if (item.state !== "pending" || active.current.has(item.id)) return;
    // The ref closes the gap before React can render the disabled button.
    active.current.add(item.id);
    setPending(new Set(active.current));
    onError?.(null);
    try {
      const result = await update({ id: item.id, trigger: { kind: "at", iso: new Date().toISOString() } });
      if (result.item === null || result.error) throw new Error(result.error ?? "This message is no longer waiting to be sent.");
      toast.show("Message scheduled to send when the session is idle");
      try { await refresh(); }
      catch { reportError("The message is scheduled, but the view could not refresh. Reopen Deferred to check its status."); }
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    } finally {
      active.current.delete(item.id);
      setPending(new Set(active.current));
    }
  }
  return { sendNow, isPending: (id: string) => pending.has(id) };
}
