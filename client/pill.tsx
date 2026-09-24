import type { PluginCleanup, PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import {
  createDeferred,
  DEFAULT_SETTINGS,
  listDeferred,
  type Deferred,
  type PillMode,
  type Trigger,
} from "../shared/defer";
import { pillLabel, queuedLabel, stateLabel } from "../shared/format";
import { canObserveAgents, followAgents, type AgentList, type AgentUpdate } from "./agents";
import { offerComposerDraft, readComposerDraft } from "./handoff";
import { DeferPopoverContent } from "./popover";
import { notifyDeferChanged, onDeferChanged } from "./refresh";

/**
 * The composer pill: a "Defer" button above every live session's composer,
 * which turns into a status ("2 deferred", "in 12m") once that session has
 * something waiting.
 *
 * It is the plugin's only in-session UI slot. Paseo offers agent-context panels
 * nowhere in its chrome — the new-tab launcher lists workspace-context panels
 * only — so without a pill on every composer, deferring from inside a session
 * means ⌘K every time. Anyone who would rather keep the composer clear can set
 * `pillMode` to `waiting`, and then only a session with a queue carries a pill.
 *
 * Paseo owns the pressable, the pending spinner, error toasts and placement; a
 * plugin owns whether the pill exists at all. There is no push channel for
 * plugin state yet, so this polls, and a mutation in a Defer view refreshes it
 * immediately through `refresh.client`.
 *
 * Pressing the pill toggles a preview of the waiting messages, so the queue can
 * be read without losing the transcript; the preview itself is the button that
 * opens the panel. The same card also carries whatever is half-written in the
 * composer, with a chip per common wait: the ordinary case — "not now, in an
 * hour" — is then one press from the prompt box, and the panel is only for the
 * timings a chip cannot say. With nothing waiting and nothing typed there is
 * nothing to preview, and the press opens the panel directly.
 */
const POLL_MS = 30_000;

/** Long enough to coalesce a burst of agent updates, short enough to feel live. */
const DEBOUNCE_MS = 250;

/**
 * Backstop for a pressed preview. Pressing the pill again closes it, but a
 * plugin cannot see clicks landing anywhere else, so a card left behind would
 * otherwise sit over the transcript forever.
 */
const PREVIEW_MS = 10_000;

/**
 * How long a press on the card keeps the pill's own toggle quiet. On web the
 * card's click also reaches Paseo's pressable underneath, and that echo would
 * re-open the preview the card just closed.
 */
const CARD_ECHO_MS = 400;

/** Pointer dwell before a hover preview opens, so passing over the pill is quiet. */
const HOVER_DELAY_MS = 300;

/** Messages spelled out in the preview before the rest are just counted. */
const PREVIEW_LIMIT = 3;

/** What the pill reads as while the session has nothing waiting. */
const IDLE_LABEL = "Defer";

const IDLE_TITLE = "Defer a message to this session";

/** Waits offered on the card. The panel is one press away for anything else. */
const QUICK_PRESETS: readonly { id: string; label: string; ms: number }[] = [
  { id: "15m", label: "15m", ms: 15 * 60_000 },
  { id: "1h", label: "1h", ms: 60 * 60_000 },
  { id: "3h", label: "3h", ms: 180 * 60_000 },
];

/** Lines of the composer draft shown on the card before it is cut off. */
const DRAFT_LINES = 2;

/** Props supplied to the legacy beta.1 component slot. */
type LegacyPillProps = {
  theme: PluginTheme;
  workspaceId: string;
  agentId: string;
};

/**
 * The host's own pill chrome, mirrored from Paseo's `composerPillStyles`:
 * `spacing[3]` and `spacing[1]` of padding inside a 1px border.
 *
 * A plugin renders *inside* that padding, so a hover region left at its natural
 * size answers only over the label and stays dead across the rest of the pill
 * the pointer is actually on. Cancelling the padding with an equal negative
 * margin grows the region to the pill's edge and leaves the layout exactly
 * where it was, since the two cancel.
 */
const HOST_PILL_INSET = { horizontal: 13, vertical: 5 };

const NO_ITEMS: readonly Deferred[] = [];

function isWaiting(item: Deferred): boolean {
  return item.state === "pending" || item.state === "sending";
}

/**
 * Which pill is showing its preview, whether a press pinned it open, and the
 * composer draft as it read when the card went up. Captured once per opening
 * rather than polled: the card is a snapshot of the moment it was asked for.
 */
interface Preview {
  agentId: string;
  sticky: boolean;
  draft: string;
}

/**
 * Waiting items and preview state per agent, for one plugin installation.
 *
 * Scoped to the installation rather than the module so two connected hosts
 * cannot collide on an agent id, and so the pill component can re-render
 * without the registration being torn down and recreated.
 */
interface PillStore {
  items(agentId: string): readonly Deferred[];
  previewing(agentId: string): boolean;
  /** True only while a press is holding the preview open. */
  pinned(agentId: string): boolean;
  /** The composer draft the open card is offering to defer, if any. */
  draft(agentId: string): string;
  subscribe(listener: () => void): () => void;
  replaceItems(next: Map<string, Deferred[]>): void;
  showPreview(agentId: string, sticky: boolean, draft: string): void;
  /** Passing an agent id only closes that pill's preview. */
  hidePreview(agentId?: string): void;
}

function createPillStore(): PillStore {
  let byAgent = new Map<string, Deferred[]>();
  let preview: Preview | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    items: (agentId) => byAgent.get(agentId) ?? NO_ITEMS,
    previewing: (agentId) => preview?.agentId === agentId,
    pinned: (agentId) => preview?.agentId === agentId && preview.sticky,
    draft: (agentId) => (preview?.agentId === agentId ? preview.draft : ""),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replaceItems(next) {
      byAgent = next;
      // A preview showing neither a queue nor a draft has nothing left to show.
      if (preview !== null && !next.has(preview.agentId) && preview.draft === "") preview = null;
      emit();
    },
    showPreview(agentId, sticky, draft) {
      const current = preview?.agentId === agentId ? preview : null;
      // Hovering a pinned preview must not un-pin it.
      const nextSticky = sticky || current?.sticky === true;
      if (current !== null && current.sticky === nextSticky && current.draft === draft) return;
      preview = { agentId, sticky: nextSticky, draft };
      emit();
    },
    hidePreview(agentId) {
      if (preview === null) return;
      if (agentId !== undefined && preview.agentId !== agentId) return;
      preview = null;
      emit();
    },
  };
}

function previewStyles(theme: PluginTheme) {
  return {
    // Stretched, with the host's padding cancelled and re-added, so the pointer
    // is answered anywhere on the pill rather than only over the label.
    pill: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 6,
      flexShrink: 1,
      minWidth: 0,
      alignSelf: "stretch" as const,
      marginVertical: -HOST_PILL_INSET.vertical,
      marginHorizontal: -HOST_PILL_INSET.horizontal,
      paddingVertical: HOST_PILL_INSET.vertical,
      paddingHorizontal: HOST_PILL_INSET.horizontal,
    },
    // Drawn above the pill rather than inside it: the track bar is one line
    // high, and the messages need room to be read.
    card: {
      position: "absolute" as const,
      bottom: "100%" as const,
      // Back inside the cancelled padding, so the card still lines up with the
      // pill's left edge rather than the region that reaches past it.
      left: HOST_PILL_INSET.horizontal,
      marginBottom: 8,
      minWidth: 220,
      maxWidth: 360,
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    cardActive: { backgroundColor: theme.colors.surface2 },
    message: { color: theme.colors.foreground, fontSize: 13 },
    meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    draft: { color: theme.colors.foreground, fontSize: 13, fontStyle: "italic" as const },
    quick: {
      gap: 6,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      paddingTop: 8,
    },
    chips: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    chip: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    chipActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    chipText: { color: theme.colors.foreground, fontSize: 12 },
    chipTextActive: { color: theme.colors.accentForeground, fontSize: 12 },
    hint: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      paddingTop: 6,
    },
  };
}

function createDeferPill(
  store: PillStore,
  openPanelFor: (agentId: string, workspaceId: string) => void,
  quickDefer: (agentId: string, trigger: Trigger) => Promise<Deferred>,
) {
  return function DeferPill({ theme, agentId, workspaceId }: LegacyPillProps) {
    const subscribe = useCallback((listener: () => void) => store.subscribe(listener), []);
    const readItems = useCallback(() => store.items(agentId), [agentId]);
    const readPreview = useCallback(() => store.previewing(agentId), [agentId]);
    const readDraft = useCallback(() => store.draft(agentId), [agentId]);
    const items = useSyncExternalStore(subscribe, readItems, readItems);
    const previewing = useSyncExternalStore(subscribe, readPreview, readPreview);
    const draft = useSyncExternalStore(subscribe, readDraft, readDraft);
    const styles = useMemo(() => previewStyles(theme), [theme]);
    const toast = useToast();
    const [queueing, setQueueing] = useState<string | null>(null);

    // Hover is a bonus for pointer platforms: it opens the same preview without
    // spending a press. Touch hosts never fire these and use press, press.
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearHoverTimer = useCallback(() => {
      if (hoverTimer.current === null) return;
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }, []);
    useEffect(() => clearHoverTimer, [clearHoverTimer]);

    const onPointerEnter = useCallback(() => {
      // Nothing waiting and nothing typed means nothing to preview; the press
      // opens the panel.
      if (hoverTimer.current !== null) return;
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        const typed = readComposerDraft(agentId);
        if (store.items(agentId).length === 0 && typed === "") return;
        store.showPreview(agentId, false, typed);
      }, HOVER_DELAY_MS);
    }, [agentId]);

    const onPointerLeave = useCallback(() => {
      clearHoverTimer();
      // A pressed preview owns its own dismissal timer; leave it alone.
      if (!store.pinned(agentId)) store.hidePreview(agentId);
    }, [agentId, clearHoverTimer]);

    /**
     * On web a chip's click also reaches the card underneath it, which would
     * open the panel the chip just made unnecessary. Same echo, same answer as
     * the one between the card and the pill.
     */
    const chipPressedAt = useRef(0);
    const onCardPress = useCallback(() => {
      if (Date.now() - chipPressedAt.current < CARD_ECHO_MS) return;
      openPanelFor(agentId, workspaceId);
    }, [agentId, workspaceId]);

    const onQuickPress = useCallback(
      (preset: (typeof QUICK_PRESETS)[number]) => {
        chipPressedAt.current = Date.now();
        if (queueing !== null) return;
        setQueueing(preset.id);
        void quickDefer(agentId, { kind: "after", ms: preset.ms })
          .then((item) => {
            // Paseo gives a plugin no way to clear its own composer, so the
            // prompt box still holds this text: say so where it will be read.
            toast.show(`${queuedLabel(item)} \u00b7 the prompt box still holds it`);
          })
          .catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : String(error)),
          )
          .finally(() => setQueueing(null));
      },
      [agentId, queueing, toast],
    );

    const cardStyle = useCallback(
      ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
        styles.card,
        hovered === true || pressed ? styles.cardActive : null,
      ],
      [styles],
    );

    // Overdue means the session was busy when the message came due, so it is
    // waiting for the turn to end rather than for the clock.
    const overdue = items.some(
      (item) => item.dueAt !== null && Date.parse(item.dueAt) <= Date.now(),
    );
    const color = overdue ? theme.colors.statusWarning : theme.colors.foregroundMuted;
    const shown = items.slice(0, PREVIEW_LIMIT);
    const rest = items.length - shown.length;

    return (
      <View style={styles.pill} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
        <Icon name="Clock" size={13} color={color} />
        <Text numberOfLines={1} style={{ color, flexShrink: 1 }}>
          {items.length === 0 ? IDLE_LABEL : pillLabel(items)}
        </Text>
        {previewing && (items.length > 0 || draft !== "") ? (
          // Its own pressable, so the card opens the panel while a press on the
          // pill behind it only toggles this card.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the Defer panel"
            onPress={onCardPress}
            style={cardStyle}
          >
            {shown.map((item) => (
              <View key={item.id}>
                <Text numberOfLines={3} style={styles.message}>
                  {item.text}
                </Text>
                <Text style={styles.meta}>{stateLabel(item)}</Text>
              </View>
            ))}
            {rest > 0 ? <Text style={styles.meta}>{`+${rest} more`}</Text> : null}

            {draft === "" ? null : (
              // The whole point of the card: the common answer to "not now" is
              // a short wait, and it should not cost a panel.
              <View style={items.length === 0 ? undefined : styles.quick}>
                <Text style={styles.meta}>Defer what you are writing</Text>
                <Text numberOfLines={DRAFT_LINES} style={styles.draft}>
                  {draft}
                </Text>
                <View style={styles.chips}>
                  {QUICK_PRESETS.map((preset) => {
                    const busy = queueing === preset.id;
                    return (
                      <Pressable
                        key={preset.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Defer this by ${preset.label}`}
                        accessibilityState={{ busy, disabled: queueing !== null }}
                        disabled={queueing !== null}
                        onPress={() => onQuickPress(preset)}
                        style={[styles.chip, busy ? styles.chipActive : null]}
                      >
                        <Text style={busy ? styles.chipTextActive : styles.chipText}>
                          {busy ? "\u2026" : preset.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            <Text style={styles.hint}>{draft === "" ? "Open Defer" : "Open Defer for another time"}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };
}

/**
 * Headless client contribution. Registered from `index.client.tsx`, once per
 * plugin installation in each connected app.
 */
export function contributeClient(client: PluginClientContext): PluginCleanup {
  const store = createPillStore();
  const DeferPill = createDeferPill(store, openPanelFor, quickDefer);
  /** Live sessions, agentId -> workspaceId. One pill each. */
  const sessions = new Map<string, string>();
  /**
   * beta.1 returns a remover function. The documented descriptor API returns a
   * handle with update/remove. Normalize both while clients roll forward.
   */
  type PillRegistration = {
    remove(): void;
    update?: (patch: { label?: string; title?: string; visible?: boolean }) => void;
  };
  const registered = new Map<string, { workspaceId: string; pill: PillRegistration }>();

  let pillMode: PillMode = DEFAULT_SETTINGS.pillMode;
  let stopped = false;
  let running = false;
  let queued = false;
  let listedSessions = false;
  /** A 0.9 observation keeps `sessions` itself; 0.8 reads once, then listens. */
  const observing = canObserveAgents(client.paseo);
  /** Whether `pillMode` and the queue have been read at least once. */
  let readQueue = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  /** Dismissal for a pressed preview; owned here so cleanup can release it. */
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the card last handled a press, to swallow the echo below it. */
  let cardPressedAt = 0;

  function clearPreviewTimer(): void {
    if (previewTimer === null) return;
    clearTimeout(previewTimer);
    previewTimer = null;
  }

  /** The card's own press: open the panel and put the card away. */
  function openPanelFor(agentId: string, workspaceId: string): void {
    if (stopped) return;
    cardPressedAt = Date.now();
    clearPreviewTimer();
    store.hidePreview(agentId);
    // Offered before the panel opens, so a prompt half-written in the composer
    // is already in the message box by the time the panel is on screen.
    offerComposerDraft(agentId);
    client.openPanel("defer", { workspaceId, agentId });
  }

  /**
   * Queues the composer draft straight from the card. Read again at the press
   * rather than trusting what the card was showing: the prompt box may have
   * moved on since it opened, and the message that gets queued has to be the
   * one the user can see.
   */
  async function quickDefer(agentId: string, trigger: Trigger): Promise<Deferred> {
    // A chip lives inside Paseo's own pressable, so on web this press also
    // arrives at the pill underneath. Left alone, that echo re-opens the card
    // the moment its work is done.
    cardPressedAt = Date.now();
    const text = readComposerDraft(agentId);
    if (text.trim() === "") throw new Error("There is nothing in the prompt box to defer.");
    const { item } = await client.rpc(createDeferred, { agentId, text, trigger });
    if (!stopped) {
      clearPreviewTimer();
      store.hidePreview(agentId);
    }
    // Refreshes this pill and any open Defer view, without waiting for a poll.
    notifyDeferChanged();
    return item;
  }

  /** The pill's own press: show the card, or put it away again. */
  function togglePreview(agentId: string, workspaceId: string): void {
    if (stopped) return;
    // The card sits inside Paseo's pressable, so on web its click arrives here
    // too. Ignoring the echo keeps a card press from re-opening the card.
    if (Date.now() - cardPressedAt < CARD_ECHO_MS) return;
    clearPreviewTimer();
    if (store.previewing(agentId)) {
      store.hidePreview(agentId);
      return;
    }
    const draft = readComposerDraft(agentId);
    // With no queue to preview and nothing typed, the pill is a plain button.
    if (store.items(agentId).length === 0 && draft === "") {
      store.hidePreview(agentId);
      offerComposerDraft(agentId);
      client.openPanel("defer", { workspaceId, agentId });
      return;
    }
    store.showPreview(agentId, true, draft);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      store.hidePreview(agentId);
    }, PREVIEW_MS);
  }

  /** Whether this snapshot is a session that can hold a pill, and where. */
  function placement(agent: {
    id?: string;
    workspaceId?: string | null;
    status?: string;
  }): { agentId: string; workspaceId: string } | null {
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    if (typeof agentId !== "string" || agentId === "") return null;
    // A closed session has no composer to put a pill on.
    if (agent.status === "closed") return null;
    if (typeof workspaceId !== "string" || workspaceId === "") return null;
    return { agentId, workspaceId };
  }

  function drop(agentId: string): boolean {
    return sessions.delete(agentId);
  }

  function applyAgentUpdate(update: AgentUpdate): void {
    if (stopped) return;
    if (update.kind === "remove") {
      if (drop(update.agentId)) reconcilePills();
      return;
    }
    const place = placement(update.agent);
    if (place === null) {
      // Reaches here for a session that just closed, which must lose its pill.
      const agentId = update.agent?.id;
      if (typeof agentId === "string" && drop(agentId)) reconcilePills();
      return;
    }
    // Agents upsert on every status change; only a placement change matters.
    if (sessions.get(place.agentId) === place.workspaceId) return;
    sessions.set(place.agentId, place.workspaceId);
    // The queue read supplies the saved pill mode. Before it completes the
    // in-memory default is "always", so reconciling an early update would
    // briefly flash a pill for users configured for waiting-only mode.
    if (readQueue) reconcilePills();
  }

  /** Whether this session should be carrying a pill right now. */
  function wanted(agentId: string): boolean {
    if (!sessions.has(agentId)) return false;
    return pillMode === "always" || store.items(agentId).length > 0;
  }

  function labelFor(agentId: string): string {
    const items = store.items(agentId);
    return items.length === 0 ? IDLE_LABEL : pillLabel(items);
  }

  /** The host renders a pill's title as its hover tooltip. */
  function titleFor(agentId: string): string {
    const items = store.items(agentId);
    if (items.length === 0) return IDLE_TITLE;
    if (items.length === 1) return `Deferred: ${items[0].text}`;
    return `Deferred messages:\n${items.map((item) => `• ${item.text}`).join("\n")}`;
  }

  function normalizeRegistration(value: unknown): PillRegistration {
    if (typeof value === "function") return { remove: value as () => void };
    const handle = value as {
      remove(): void;
      update(patch: { label?: string; title?: string; visible?: boolean }): void;
    };
    return { remove: () => handle.remove(), update: (patch) => handle.update(patch) };
  }

  /** One pill per live session, mounted where that session's composer is. */
  function reconcilePills(): void {
    if (stopped) return;
    for (const [agentId, entry] of [...registered]) {
      if (wanted(agentId) && sessions.get(agentId) === entry.workspaceId) {
        entry.pill.update?.({ label: labelFor(agentId), title: titleFor(agentId), visible: true });
        continue;
      }
      // Gone, or moved to another workspace: the workspace is baked into the
      // registration, so a move has to be re-registered rather than patched.
      entry.pill.remove();
      registered.delete(agentId);
      if (store.previewing(agentId)) {
        clearPreviewTimer();
        store.hidePreview(agentId);
      }
    }

    for (const [agentId, workspaceId] of sessions) {
      if (registered.has(agentId) || !wanted(agentId)) continue;
      const contribution = {
          id: "defer",
          title: titleFor(agentId),
          workspaceId,
          agentId,
          Component: DeferPill,
          onPress() {
            togglePreview(agentId, workspaceId);
          },
          // The live v0.8 descriptor contract. beta.1 ignores this field and
          // uses the legacy fields above; newer clients ignore those and use
          // this popover descriptor instead of opening the full panel as a tab.
          button: {
            title: titleFor(agentId),
            icon: "Clock",
            label: labelFor(agentId),
            behavior: {
              kind: "popover" as const,
              Content: DeferPopoverContent,
            },
          },
        };
      const pill = normalizeRegistration(client.addComposerPill(contribution));
      registered.set(agentId, { workspaceId, pill });
    }
  }

  function replaceSessions(listed: AgentList): void {
    sessions.clear();
    for (const entry of listed.entries) {
      const place = placement(entry.agent ?? {});
      if (place === null) continue;
      sessions.set(place.agentId, place.workspaceId);
    }
    listedSessions = true;
  }

  async function loadSessions(): Promise<void> {
    const listed = await client.paseo.agents.list();
    if (stopped) return;
    replaceSessions(listed);
  }

  async function sync(): Promise<void> {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      // The subscription keeps the session set current afterwards. An
      // observation brings its own snapshot, so only the legacy path reads.
      if (!listedSessions && !observing) await loadSessions();
      const { items, settings } = await client.rpc(listDeferred, {});
      if (stopped) return;
      pillMode = settings.pillMode;
      const byAgent = new Map<string, Deferred[]>();
      for (const item of items) {
        if (!isWaiting(item)) continue;
        const existing = byAgent.get(item.agentId);
        if (existing === undefined) byAgent.set(item.agentId, [item]);
        else existing.push(item);
      }
      store.replaceItems(byAgent);
      readQueue = true;
      reconcilePills();
    } catch (error) {
      // A failed read must not kill the entrypoint: the interval retries, and
      // the panel surfaces the same failure where the user can see it.
      console.warn("[defer] pill sync failed", String(error));
    } finally {
      running = false;
      if (queued && !stopped) {
        queued = false;
        void sync();
      }
    }
  }

  function scheduleSync(): void {
    if (stopped || debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      void sync();
    }, DEBOUNCE_MS);
  }

  const unsubscribeAgents = followAgents(
    client.paseo,
    {
      // First delivery and every reconnect: the snapshot is the whole truth.
      // Before the first queue read, that read reconciles instead, so a
      // waiting-only pill mode never flashes a button on every session.
      snapshot(listed) {
        if (stopped) return;
        replaceSessions(listed);
        if (readQueue) reconcilePills();
      },
      update: applyAgentUpdate,
    },
    () => client.paseo.agents.subscribe(applyAgentUpdate),
  );

  const unsubscribeChanges = onDeferChanged(scheduleSync);
  const timer = setInterval(() => void sync(), POLL_MS);
  void sync();

  return () => {
    stopped = true;
    clearInterval(timer);
    if (debounce !== null) clearTimeout(debounce);
    clearPreviewTimer();
    unsubscribeChanges();
    unsubscribeAgents();
    for (const entry of registered.values()) entry.pill.remove();
    registered.clear();
    sessions.clear();
    store.hidePreview();
    store.replaceItems(new Map());
  };
}
