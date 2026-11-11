import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import * as clientApi from "@getpaseo/plugin/client";
import * as uiApi from "@getpaseo/plugin/client/ui";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import type { Deferred, PillMode } from "../shared/defer";
import { byDueAt, deferredTitle } from "../shared/format";
import { tickFor, TimerGlyph, useNow } from "./kit";
import { IconSwap } from "./motion";
import { DeferPopoverBody } from "./popover";

/**
 * Defer as a control in Paseo 0.16's composer toolbar (`addComposerItem`),
 * in place of the pill above the composer on older hosts.
 *
 * Paseo draws the control itself: Defer renders the host's own `Action`, an
 * icon in the toolbar when the composer has room and a titled row in its
 * overflow sheet when it does not. A composer item gets no anchored popover, so
 * the press opens Paseo's `Modal` holding the same content the pill's popover
 * had.
 *
 * On a phone Paseo puts every composer item in the overflow sheet behind the
 * model button, where Defer is hard to find, so there the item draws nothing
 * and the pill above the composer stays Defer's control (`client/form-factor.ts`
 * holds the host's rule; `contributeClient` swaps the two live).
 *
 * A composer is not told which agent it belongs to, so Defer tags every live
 * session's metadata with its own id (`AGENT_TAG`, see `tagSessions` in
 * `pill.tsx`) and the item reads it back from `useComposer().agent.metadata`.
 * An untagged composer, a draft and the New workspace screen render nothing.
 */

/** The metadata key carrying the agent's own id, written by Defer. */
export const AGENT_TAG = "defer.agentId";

/** The slice of 0.16's `PluginComposer` the item reads. */
interface ItemComposer {
  readonly context: "agent" | "draft" | "new-workspace";
  readonly agent: { readonly metadata: Readonly<Record<string, unknown>> };
  focus?(): Promise<void>;
}

interface ActionControlProps {
  title: string;
  icon: ComponentType<{ size: number; color: string }>;
  disabled?: boolean;
  onPress(event: object): void | Promise<void>;
}

/** 0.16-only host exports, read off the module so the 0.14 typings still compile. */
const host = {
  useComposer: (clientApi as unknown as { useComposer?: () => ItemComposer }).useComposer,
  Action: (uiApi as unknown as { Action?: ComponentType<ActionControlProps> }).Action,
};

/** Whether this host can draw Defer inside the composer instead of as a pill. */
export function supportsComposerItem(client: unknown): boolean {
  return (
    typeof (client as { addComposerItem?: unknown } | null)?.addComposerItem === "function" &&
    typeof host.useComposer === "function" &&
    typeof host.Action === "function"
  );
}

/** The agent id Defer stored on this composer's agent, if any. */
export function readAgentTag(metadata: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const value = metadata?.[AGENT_TAG];
  return typeof value === "string" && value !== "" ? value : null;
}

export interface ComposerItemDeps {
  /** Fires when the queue or the pill mode changes. */
  subscribe(listener: () => void): () => void;
  items(agentId: string): readonly Deferred[];
  pillMode(): PillMode;
  openQueue(): void;
  /** Fires when the phone/desktop form factor flips. */
  subscribeCompact(listener: () => void): () => void;
  /** Whether the app is laid out for a phone, where the pill is Defer's control instead. */
  compact(): boolean;
}

const NO_ITEMS: readonly Deferred[] = [];

/**
 * The control's title: its tooltip, accessibility label and overflow-sheet row,
 * so it leads with the action and then carries the queue ("Defer · 2 waiting ·
 * next 4:42 PM"), the same summary the pill used.
 */
export function itemTitle(items: readonly Deferred[]): string {
  if (items.length === 0) return "Defer a message";
  return `Defer \u00b7 ${deferredTitle(items).replace(/^(\d+) deferred/, "$1 waiting")}`;
}

/**
 * Which session's dialog is open, and which mounted item owns it. A wide
 * composer keeps the toolbar item mounted while the overflow sheet mounts a
 * second one, so only the first claimant draws the dialog.
 */
function createDialogStore() {
  const listeners = new Set<() => void>();
  const open = new Set<string>();
  const owners = new Map<string, symbol>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    isOpen: (agentId: string) => open.has(agentId),
    setOpen(agentId: string, next: boolean) {
      if (open.has(agentId) === next) return;
      if (next) open.add(agentId);
      else open.delete(agentId);
      emit();
    },
    owner: (agentId: string) => owners.get(agentId),
    claim(agentId: string, self: symbol) {
      if (owners.has(agentId)) return;
      owners.set(agentId, self);
      emit();
    },
    release(agentId: string, self: symbol) {
      if (owners.get(agentId) !== self) return;
      owners.delete(agentId);
      emit();
    },
  };
}

export function createDeferComposerItem(deps: ComposerItemDeps): ComponentType<PluginHostProps> {
  const dialogs = createDialogStore();

  /**
   * The control's icon: a plain clock while nothing waits, then the timer glyph
   * draining toward the next send, drawn in `foreground` so a waiting message
   * stands out from the toolbar's muted icons in either theme.
   */
  function iconFor(agentId: string, theme: PluginTheme): ComponentType<{ size: number; color: string }> {
    return function DeferControlIcon({ size, color }) {
      const read = useCallback(() => deps.items(agentId), []);
      const items = useSyncExternalStore(deps.subscribe, read, read);
      const next = items.length === 0 ? undefined : byDueAt(items)[0];
      const now = useNow(next === undefined ? 60_000 : tickFor([next], Date.now()));
      return (
        <IconSwap swapKey={next === undefined ? "idle" : next.state === "sending" ? "sending" : "timer"} size={size}>
          {next === undefined ? (
            <Icon name="Clock" size={size} color={color} />
          ) : (
            <TimerGlyph item={next} now={now} size={size} color={theme.colors.foreground} />
          )}
        </IconSwap>
      );
    };
  }

  return function DeferComposerItem(props: PluginHostProps) {
    const composer = host.useComposer!();
    const agentId = composer.context === "agent" ? readAgentTag(composer.agent.metadata) : null;
    const key = agentId ?? "";
    const readItems = useCallback(() => (key === "" ? NO_ITEMS : deps.items(key)), [key]);
    const items = useSyncExternalStore(deps.subscribe, readItems, readItems);
    const mode = useSyncExternalStore(deps.subscribe, deps.pillMode, deps.pillMode);
    const readOpen = useCallback(() => key !== "" && dialogs.isOpen(key), [key]);
    const open = useSyncExternalStore(dialogs.subscribe, readOpen, readOpen);
    const readOwner = useCallback(() => (key === "" ? undefined : dialogs.owner(key)), [key]);
    const owner = useSyncExternalStore(dialogs.subscribe, readOwner, readOwner);
    const [self] = useState(() => Symbol("defer-item"));
    const phone = useSyncExternalStore(deps.subscribeCompact, deps.compact, deps.compact);

    // Claim the dialog when nobody holds it (first mount, or the owner left);
    // release it only when this item unmounts or moves to another session.
    useEffect(() => {
      if (key !== "" && owner === undefined) dialogs.claim(key, self);
    }, [key, owner, self]);
    useEffect(() => {
      if (key === "") return;
      return () => dialogs.release(key, self);
    }, [key, self]);

    const icon = useMemo(() => iconFor(key, props.theme), [key, props.theme]);
    const onPress = useCallback(() => {
      if (key !== "") dialogs.setOpen(key, true);
    }, [key]);
    const [editing, setEditing] = useState(false);
    const close = useCallback(() => {
      if (key === "") return;
      dialogs.setOpen(key, false);
      setEditing(false);
    }, [key]);
    const openQueue = useCallback(() => deps.openQueue(), []);

    if (agentId === null) return null;
    // A phone keeps the pill above the composer instead (see `contributeClient`).
    // Either signal is enough: the entrypoint's, which the pills follow, and the
    // host's own, which decides whether this item would land in the overflow
    // sheet. Both read the same breakpoint, so neither shows both controls.
    if (phone || props.layout.compact) return null;
    // "Only while messages wait": no control on a session with nothing queued,
    // unless its dialog is open (queueing from it must not unmount it mid-way).
    if (mode === "waiting" && items.length === 0 && !open) return null;

    const Action = host.Action!;
    return (
      <>
        <Action title={itemTitle(items)} icon={icon} onPress={onPress} />
        {owner === self ? (
          <Modal title={editing ? "Edit deferred message" : "Defer a message"} open={open} onOpenChange={(next) => (next ? onPress() : close())}>
            <Modal.Content>
              {open ? (
                <DeferPopoverBody
                  theme={props.theme}
                  layout={props.layout}
                  agentId={agentId}
                  close={close}
                  openQueue={openQueue}
                  inDialog
                  onEditingChange={setEditing}
                />
              ) : null}
            </Modal.Content>
          </Modal>
        ) : null}
      </>
    );
  };
}
