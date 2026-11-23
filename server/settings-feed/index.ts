// Vendored from paseo-plugin-kit v0.4.0-beta.0 (settings-feed-server/index.ts). Do not edit; change the kit and run `paseo-kit vendor settings-feed-server <dir>`.
/** Bridge the host's settings notifications to plugin subscriptions, without a polling timer. */
type Push = (document: unknown) => Promise<void>;
type Context = { push: Push; signal: AbortSignal };
export function registerSettingsFeed(
  server: unknown,
  contract: unknown,
  settings: { read(): Promise<unknown>; subscribe?: unknown },
): () => void {
  const host = server as { handle(contract: unknown, handler: (input: unknown, context: Context) => void): void };
  const subscribe = settings.subscribe;
  if (typeof subscribe !== "function") return () => {};
  let stopped = false, revision = 0;
  const subscribers = new Map<Push, () => void>();
  const send = (push: Push, document: unknown) => {
    if (stopped || !subscribers.has(push)) return;
    void Promise.resolve().then(() => {
      if (!stopped && subscribers.has(push)) return push(document);
    }).catch(() => { subscribers.get(push)?.(); });
  };
  let off: () => void;
  try {
    off = subscribe.call(settings, (document: unknown) => {
      revision++;
      for (const push of subscribers.keys()) send(push, document);
    }) as (() => void);
  } catch { return () => {}; }
  try {
    host.handle(contract, (_input, context) => {
      if (stopped || context.signal.aborted) return;
      if (typeof context.push !== "function") throw new Error("Settings feeds require plugin subscriptions.");
      const remove = () => { subscribers.delete(context.push); context.signal.removeEventListener("abort", remove); };
      subscribers.set(context.push, remove);
      context.signal.addEventListener("abort", remove, { once: true });
      const current = revision;
      void settings.read().then(document => {
        if (revision === current) send(context.push, document);
      }).catch(remove);
    });
  } catch {
    off(); return () => {};
  }
  return () => {
    if (stopped) return;
    stopped = true; off();
    for (const remove of [...subscribers.values()]) remove();
  };
}
