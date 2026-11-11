import { clientBridge, type DeferOffer } from "../shared/bridge";
import { livePrompt } from "./host-composer";

/**
 * Carries what is already typed in a session's composer into the Defer message
 * box, so pressing **Defer** with a half-written prompt in front of you does not
 * mean typing it again.
 *
 * Paseo hands a plugin no composer state: `PluginComposerPillContribution.onPress`
 * takes no arguments, and neither the pill props nor the panel props carry the
 * draft (rechecked during the v0.8 migration). What the app *does* do is persist every
 * composer draft itself, under one well-known key, so on a host that keeps that
 * store somewhere a plugin can read — the desktop app and the web app, both of
 * which are ordinary web origins — the text can be read back at the moment the
 * pill is pressed. Everywhere else this quietly finds nothing and the box opens
 * empty, exactly as before.
 *
 * Two things follow from reading a private store rather than being handed the
 * draft, and both are deliberate:
 *
 * - It is a **copy, not a move**. The app's in-memory draft is the source of
 *   truth and does not watch its own storage, so writing to it would be
 *   overwritten and would not clear the composer on screen. The composer says so
 *   in as many words, because a prompt left in the box is one Enter away from
 *   being sent immediately as well as deferred.
 * - Everything here is best effort. A missing key, a schema that moved, another
 *   host: all of them read as "no draft", never as an error.
 */

/** Where the app persists composer drafts. */
const STORAGE_KEY = "paseo-drafts";

/** Records are keyed `agent:<serverId>:<agentId>`; a plugin is told no server id. */
const AGENT_KEY_PREFIX = "agent:";

/**
 * How long an offer waits for a Defer view to appear. Long enough for a panel
 * to open in a new tab on a busy machine, short enough that text read from a
 * composer minutes ago can never turn up in a box opened for something else.
 */
const OFFER_TTL_MS = 30_000;

type Listener = (offer: DeferOffer) => void;

interface Waiting extends DeferOffer {
  agentId: string;
  at: number;
}

const listeners = new Map<string, Set<Listener>>();

/** An offer with nowhere to go yet, kept for the view that is still opening. */
let waiting: Waiting | null = null;

function deliver(agentId: string, offer: DeferOffer): boolean {
  const targets = listeners.get(agentId);
  if (targets === undefined || targets.size === 0) return false;
  // Copied first: a listener may unsubscribe itself while being called.
  for (const listener of [...targets]) {
    try {
      listener(offer);
    } catch {
      // One broken view must not stop the others from being handed the text.
    }
  }
  return true;
}

/**
 * Reads one session's draft text out of the app's persisted draft store.
 *
 * Separate from the storage lookup so the shape can be exercised directly, and
 * written to mirror the app's own `toDraftInputIfReady`: only an `active`
 * record holds text a person is still writing. A cleared record keeps its key
 * with an empty string and a `sent` or `abandoned` lifecycle, and handing *that*
 * back would resurrect a message the session has already had.
 */
export function readDraftText(raw: string | null | undefined, agentId: string): string {
  if (typeof raw !== "string" || raw === "" || agentId === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const drafts = (parsed as { state?: { drafts?: unknown } } | null)?.state?.drafts;
  if (drafts === null || typeof drafts !== "object") return "";

  const suffix = `:${agentId}`;
  let best: { text: string; updatedAt: number } | null = null;
  for (const [key, value] of Object.entries(drafts as Record<string, unknown>)) {
    if (!key.startsWith(AGENT_KEY_PREFIX) || !key.endsWith(suffix)) continue;
    if (value === null || typeof value !== "object") continue;
    const record = value as {
      input?: { text?: unknown } | null;
      text?: unknown;
      lifecycle?: unknown;
      updatedAt?: unknown;
    };
    if (record.lifecycle !== "active") continue;
    // Older records kept the draft flat rather than under `input`; the app's own
    // migration still accepts both, so this does too.
    const text = record.input?.text ?? record.text;
    if (typeof text !== "string" || text.trim() === "") continue;
    const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
    // One agent id can only be live on one server, but pick the freshest record
    // rather than whichever the object happens to list first.
    if (best === null || updatedAt > best.updatedAt) best = { text, updatedAt };
  }
  return best?.text ?? "";
}

/**
 * The session's composer text. On a host with composer controls (Paseo 0.16)
 * that is the live prompt itself; elsewhere it is the same read as above,
 * against whatever storage this host actually has.
 */
export function readComposerDraft(agentId: string): string {
  const live = livePrompt(agentId);
  if (live !== null) return live.trim() === "" ? "" : live;
  try {
    const storage = (globalThis as { localStorage?: { getItem(key: string): string | null } })
      .localStorage;
    if (storage === undefined || storage === null) return "";
    return readDraftText(storage.getItem(STORAGE_KEY), agentId);
  } catch {
    // A host that refuses storage access is a host with no draft to offer.
    return "";
  }
}

/**
 * Hands text, and optionally the timing to go with it, to whichever Defer view
 * is about to show. The offer goes to any view already mounted for that
 * session; with none, it waits for one to subscribe. Either way it is handed
 * over once — a view that mounts later, or a second view of the same session,
 * is not re-filled behind the user's back.
 */
export function offerDefer(agentId: string, offer: DeferOffer): void {
  if (offer.text.trim() === "" && offer.trigger === null) return;
  if (deliver(agentId, offer)) {
    waiting = null;
    return;
  }
  waiting = { agentId, ...offer, at: Date.now() };
}

/**
 * The same, for this session's composer draft. Called as the panel is opened,
 * not while typing, so nothing is read from the app's storage unless the user
 * asked for Defer.
 */
export function offerComposerDraft(agentId: string): void {
  offerDefer(agentId, { text: readComposerDraft(agentId), trigger: null, fromComposer: true });
}

/** Returns an unsubscribe function; safe to call more than once. */
export function onComposerDraftOffered(agentId: string, listener: Listener): () => void {
  const targets = listeners.get(agentId) ?? new Set<Listener>();
  targets.add(listener);
  listeners.set(agentId, targets);

  // A press opens the panel, so the offer is normally made before there is
  // anything to hand it to.
  if (waiting !== null && waiting.agentId === agentId) {
    const { agentId: _agent, at, ...offer } = waiting;
    waiting = null;
    if (Date.now() - at < OFFER_TTL_MS) {
      try {
        listener(offer);
      } catch {
        // Opening the box matters more than filling it.
      }
    }
  }

  return () => {
    const current = listeners.get(agentId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(agentId);
  };
}

// Exposed through the shared bridge to the v0.8 client entrypoint.
clientBridge.offer = offerDefer;
