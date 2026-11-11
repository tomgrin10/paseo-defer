/**
 * The host's own composer controls, where the host has them.
 *
 * Paseo 0.16 hands plugins `client.composers({ agentId })`: the live prompt of a
 * running agent's composer, and `setPrompt` to change it. Older hosts have no
 * such call, and there Defer keeps reading the app's persisted draft store
 * (`client/handoff.ts`) and asks the user to clear the prompt box by hand.
 *
 * Everything here is feature-detected and best effort: a missing call, an
 * unknown agent or a throwing host all read as "no composer", never as an
 * error, so the caller falls back to the 0.15 behaviour.
 */

/** The slice of the 0.16 `PluginComposer` this plugin uses. */
export interface HostComposer {
  readonly prompt: string;
  setPrompt(text: string): void;
}

type ComposersFn = (selector: { agentId: string }) => readonly HostComposer[];

let composers: ComposersFn | null = null;

/**
 * Remembers the host's `composers` call, when it has one. Called once from the
 * client entrypoint with the raw host context; returns the matching release.
 */
export function attachComposerHost(host: unknown): () => void {
  const candidate = (host as { composers?: unknown } | null)?.composers;
  if (typeof candidate !== "function") return () => {};
  const bound: ComposersFn = (selector) => (candidate as ComposersFn).call(host, selector);
  composers = bound;
  return () => {
    if (composers === bound) composers = null;
  };
}

/** This running agent's composer, or null on a host without the API. */
export function composerFor(agentId: string): HostComposer | null {
  if (composers === null || agentId === "") return null;
  try {
    const found = composers({ agentId })[0];
    return found !== undefined && typeof found.prompt === "string" && typeof found.setPrompt === "function"
      ? found
      : null;
  } catch {
    return null;
  }
}

/** The live prompt text, or null when the host cannot say (0.15 and older). */
export function livePrompt(agentId: string): string | null {
  return composerFor(agentId)?.prompt ?? null;
}

/** Whether Defer can empty this agent's prompt box itself after taking its text. */
export function canClearComposer(agentId: string): boolean {
  return composerFor(agentId) !== null;
}

export type ClearOutcome = "cleared" | "changed" | "unsupported";

/**
 * Empties the prompt box, but only while it still holds exactly `taken`, the
 * text Defer took from it. If the user has typed since, their new text stays.
 */
export function clearComposerIfUnchanged(agentId: string, taken: string): ClearOutcome {
  const composer = composerFor(agentId);
  if (composer === null) return "unsupported";
  if (taken === "" || composer.prompt !== taken) return "changed";
  try {
    composer.setPrompt("");
    return "cleared";
  } catch {
    return "unsupported";
  }
}
