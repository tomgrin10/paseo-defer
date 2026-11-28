import type { PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { subscribeDisplay } from "./display";

export function withButtonVisibility(client: PluginClientContext) {
  const entries = new Set<{ reconcile(): void; remove(): void }>();
  let enableHeader = true;
  let enableComposer = true;
  function gated<K extends "addHeaderButton" | "addComposerPill">(method: K, input: Parameters<PluginClientContext[K]>[0]): PluginButtonRegistration {
    let descriptor = input.button;
    let registration: PluginButtonRegistration | undefined;
    const entry = {
      reconcile() {
        const enabled = method === "addHeaderButton" ? enableHeader : enableComposer;
        if (enabled && !registration) registration = (client[method] as (value: typeof input) => PluginButtonRegistration)({ ...input, button: descriptor });
        if (!enabled && registration) { registration.remove(); registration = undefined; }
      },
      remove() { registration?.remove(); registration = undefined; entries.delete(entry); },
    };
    entries.add(entry);
    entry.reconcile();
    return { remove: entry.remove, update(patch) { descriptor = { ...descriptor, ...patch }; registration?.update(patch); } };
  }
  /** 0.16's composer item, shown or removed with the same Composer setting as the pill. */
  function gatedItem(input: unknown): () => void {
    let remove: (() => void) | undefined;
    const add = (client as unknown as { addComposerItem(value: unknown): () => void }).addComposerItem.bind(client);
    const entry = {
      reconcile() {
        if (enableComposer && !remove) remove = add(input);
        if (!enableComposer && remove) { remove(); remove = undefined; }
      },
      remove() { remove?.(); remove = undefined; entries.delete(entry); },
    };
    entries.add(entry);
    entry.reconcile();
    return entry.remove;
  }
  const buttons = Object.create(client) as PluginClientContext;
  buttons.addHeaderButton = input => gated("addHeaderButton", input);
  buttons.addComposerPill = input => gated("addComposerPill", input);
  if (typeof (client as { addComposerItem?: unknown }).addComposerItem === "function") {
    (buttons as unknown as { addComposerItem: typeof gatedItem }).addComposerItem = gatedItem;
  }
  const unsubscribe = subscribeDisplay(values => {
    
    enableComposer = values.enable_composer_button;
    for (const entry of entries) entry.reconcile();
  });
  return { client: buttons, dispose() { unsubscribe(); for (const entry of [...entries]) entry.remove(); } };
}
