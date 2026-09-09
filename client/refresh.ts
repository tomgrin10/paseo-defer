/**
 * In-app notifier tying the Defer views to the composer pill.
 *
 * Paseo has no server-to-client push for plugin state yet, so the pill polls.
 * Polling alone would leave a stale count on screen for up to one interval
 * after the user queues or cancels something in a panel, and the panel and the
 * pill live in the same client bundle, so a plain module-scope fan-out closes
 * that gap without another daemon round trip.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** Returns an unsubscribe function; safe to call more than once. */
export function onDeferChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyDeferChanged(): void {
  // Copied first: a listener may unsubscribe itself while being called.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One broken view must not stop the others from refreshing.
    }
  }
}
