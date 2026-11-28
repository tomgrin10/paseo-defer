// Vendored from paseo-plugin-kit v0.4.0-beta.0 (settings-feed-client/index.ts). Do not edit; change the kit and run `paseo-kit vendor settings-feed-client <dir>`.
/** Push settings on current hosts; read once a minute while a feed is unavailable. */
type Handle = (() => void) & { ready?: Promise<unknown> };
type Clock = Pick<typeof globalThis, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">;
type Timer = ReturnType<typeof setTimeout>;

export function watchSettings<Document>(o: {
  client: unknown;
  contract: unknown;
  read(): Promise<Document>;
  apply(document: Document): void;
  /** Changes from this client's settings screen invalidate an older RPC read. */
  revision?: () => number;
  clock?: Clock;
}): { stop(): void } {
  const clock = o.clock ?? globalThis;
  const client = o.client as { subscribe?: (contract: unknown, input: object, event: (document: Document) => void, options: { onClosed(): void }) => Handle };
  let stopped = false, pending = false, live = true, attempt = 0, generation = 0, eventRevision = 0;
  let poll: Timer | undefined, retry: Timer | undefined, steady: Timer | undefined, handle: Handle | undefined;
  const read = async () => {
    if (stopped || pending) return;
    pending = true;
    const current = eventRevision, revision = o.revision?.();
    try {
      const document = await o.read();
      if (!stopped && current === eventRevision && revision === o.revision?.()) o.apply(document);
    } catch { /* Keep the last valid setting through a disconnect. */ }
    finally { pending = false; }
  };
  const stopPoll = () => { if (poll !== undefined) clock.clearInterval(poll); poll = undefined; };
  const startPoll = () => {
    if (poll !== undefined || stopped) return;
    void read();
    poll = clock.setInterval(() => void read(), 60_000);
  };
  const clearSteady = () => { if (steady !== undefined) clock.clearTimeout(steady); steady = undefined; };
  const release = (h: Handle | undefined) => { try { h?.(); } catch { /* Already closed. */ } };
  const start = () => {
    retry = undefined;
    if (stopped) return;
    const mine = ++generation;
    const closed = () => {
      if (stopped || mine !== generation) return;
      generation++; clearSteady();
      const old = handle; handle = undefined; release(old);
      const wasLive = live; live = false;
      const delay = attempt < 15 ? 1_000 : Math.min(30_000, 1_000 * 2 ** Math.min(5, attempt - 14));
      attempt++;
      retry = clock.setTimeout(start, delay);
      if (wasLive) startPoll();
    };
    try {
      const h = client.subscribe!.call(o.client, o.contract, {}, document => {
        if (!stopped && mine === generation) { eventRevision++; o.apply(document); }
      }, { onClosed: closed });
      if (stopped || mine !== generation) { release(h); return; }
      handle = h;
      Promise.resolve(h.ready).then(() => {
        if (stopped || mine !== generation) return;
        clearSteady();
        // Acknowledgement followed by immediate closure must not restart RPC polling every second.
        steady = clock.setTimeout(() => {
          steady = undefined;
          if (stopped || mine !== generation) return;
          live = true; attempt = 0; stopPoll();
        }, 30_000);
      }, closed);
    } catch { closed(); }
  };
  if (typeof client?.subscribe === "function") start();
  else startPoll();
  return { stop() {
    if (stopped) return;
    stopped = true; generation++;
    stopPoll(); clearSteady();
    if (retry !== undefined) clock.clearTimeout(retry);
    release(handle); handle = undefined;
  } };
}
