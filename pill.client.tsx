import {
  Icon,
  type PluginCleanup,
  type PluginClientContext,
  type PluginComposerPillProps,
  type PluginTheme,
} from "@getpaseo/plugin";
import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { DEFAULT_SETTINGS, listDeferred, type Deferred, type PillMode } from "./defer.shared";
import { pillLabel, stateLabel } from "./format.shared";
import { onDeferChanged } from "./refresh.client";

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
 * opens the panel. With an empty queue there is nothing to preview and the
 * press opens the panel directly.
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

const NO_ITEMS: readonly Deferred[] = [];

function isWaiting(item: Deferred): boolean {
  return item.state === "pending" || item.state === "sending";
}

/** Which pill is showing its preview, and whether a press pinned it open. */
interface Preview {
  agentId: string;
  sticky: boolean;
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
  subscribe(listener: () => void): () => void;
  replaceItems(next: Map<string, Deferred[]>): void;
  showPreview(agentId: string, sticky: boolean): void;
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
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replaceItems(next) {
      byAgent = next;
      // A preview of a queue that just emptied has nothing left to show.
      if (preview !== null && !next.has(preview.agentId)) preview = null;
      emit();
    },
    showPreview(agentId, sticky) {
      const current = preview?.agentId === agentId ? preview : null;
      // Hovering a pinned preview must not un-pin it.
      const nextSticky = sticky || current?.sticky === true;
      if (current !== null && current.sticky === nextSticky) return;
      preview = { agentId, sticky: nextSticky };
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
    pill: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      flexShrink: 1,
      minWidth: 0,
    },
    // Drawn above the pill rather than inside it: the track bar is one line
    // high, and the messages need room to be read.
    card: {
      position: "absolute" as const,
      bottom: "100%" as const,
      left: 0,
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
) {
  return function DeferPill({ theme, agentId, workspaceId }: PluginComposerPillProps) {
    const subscribe = useCallback((listener: () => void) => store.subscribe(listener), []);
    const readItems = useCallback(() => store.items(agentId), [agentId]);
    const readPreview = useCallback(() => store.previewing(agentId), [agentId]);
    const items = useSyncExternalStore(subscribe, readItems, readItems);
    const previewing = useSyncExternalStore(subscribe, readPreview, readPreview);
    const styles = useMemo(() => previewStyles(theme), [theme]);

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
      // Nothing waiting means nothing to preview; the press opens the panel.
      if (store.items(agentId).length === 0 || hoverTimer.current !== null) return;
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        store.showPreview(agentId, false);
      }, HOVER_DELAY_MS);
    }, [agentId]);

    const onPointerLeave = useCallback(() => {
      clearHoverTimer();
      // A pressed preview owns its own dismissal timer; leave it alone.
      if (!store.pinned(agentId)) store.hidePreview(agentId);
    }, [agentId, clearHoverTimer]);

    const onCardPress = useCallback(
      () => openPanelFor(agentId, workspaceId),
      [agentId, workspaceId],
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
        {previewing && items.length > 0 ? (
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
            <Text style={styles.hint}>Open Defer</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };
}

/**
 * Headless client entrypoint. Registered from `index.ts` with
 * `plugin.addClientSide`, once per plugin installation in each connected app.
 */
export function contributeClient(client: PluginClientContext): PluginCleanup {
  const store = createPillStore();
  const DeferPill = createDeferPill(store, openPanelFor);
  /** Live sessions, agentId -> workspaceId. One pill each. */
  const sessions = new Map<string, string>();
  /** agentId -> the workspace its pill was registered against, and its remover. */
  const registered = new Map<string, { workspaceId: string; remove: () => void }>();

  let pillMode: PillMode = DEFAULT_SETTINGS.pillMode;
  let stopped = false;
  let running = false;
  let queued = false;
  let listedSessions = false;
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
    client.openPanel("defer", { workspaceId, agentId });
  }

  /** The pill's own press: show the card, or put it away again. */
  function togglePreview(agentId: string, workspaceId: string): void {
    if (stopped) return;
    // The card sits inside Paseo's pressable, so on web its click arrives here
    // too. Ignoring the echo keeps a card press from re-opening the card.
    if (Date.now() - cardPressedAt < CARD_ECHO_MS) return;
    clearPreviewTimer();
    // An idle pill is a plain button: there is no queue to preview.
    if (store.items(agentId).length === 0) {
      store.hidePreview(agentId);
      client.openPanel("defer", { workspaceId, agentId });
      return;
    }
    if (store.previewing(agentId)) {
      store.hidePreview(agentId);
      return;
    }
    store.showPreview(agentId, true);
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

  /** Whether this session should be carrying a pill right now. */
  function wanted(agentId: string): boolean {
    if (!sessions.has(agentId)) return false;
    return pillMode === "always" || store.items(agentId).length > 0;
  }

  /** One pill per live session, mounted where that session's composer is. */
  function reconcilePills(): void {
    if (stopped) return;
    for (const [agentId, entry] of [...registered]) {
      if (wanted(agentId) && sessions.get(agentId) === entry.workspaceId) continue;
      // Gone, or moved to another workspace: the workspace is baked into the
      // registration, so a move has to be re-registered rather than patched.
      entry.remove();
      registered.delete(agentId);
      if (store.previewing(agentId)) {
        clearPreviewTimer();
        store.hidePreview(agentId);
      }
    }

    for (const [agentId, workspaceId] of sessions) {
      if (registered.has(agentId) || !wanted(agentId)) continue;
      registered.set(agentId, {
        workspaceId,
        remove: client.addComposerPill({
          id: "defer",
          title: "Defer a message to this session",
          workspaceId,
          agentId,
          Component: DeferPill,
          onPress() {
            togglePreview(agentId, workspaceId);
          },
        }),
      });
    }
  }

  async function loadSessions(): Promise<void> {
    const listed = await client.paseo.agents.list();
    if (stopped) return;
    sessions.clear();
    for (const entry of listed.entries) {
      const place = placement(entry.agent ?? {});
      if (place === null) continue;
      sessions.set(place.agentId, place.workspaceId);
    }
    listedSessions = true;
  }

  async function sync(): Promise<void> {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      // The subscription keeps the session set current afterwards.
      if (!listedSessions) await loadSessions();
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

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
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
    reconcilePills();
  });

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
    for (const entry of registered.values()) entry.remove();
    registered.clear();
    sessions.clear();
    store.hidePreview();
    store.replaceItems(new Map());
  };
}
