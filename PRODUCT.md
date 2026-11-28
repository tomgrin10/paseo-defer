# Defer

<!-- impeccable:product-schema 1 -->

> Written during the November 2026 UI polish pass without a live interview. Facts come from the
> README, AGENTS.md, the code and the owner's written brief; lines marked *(inferred)* are
> assumptions to confirm.

## Platform

adaptive

## Users

Developers who run several Paseo coding agents at once and want to hand an agent its next
instruction now without sending it now: because the agent is mid-turn, because the usage window is
nearly spent, or because the work should start later (tomorrow morning, after a deploy). Agents
themselves can also schedule follow-ups to their own session through Defer's agent tools.

## Product Purpose

Queue a message for one agent session and deliver it later: after a delay, at a local time, or when
the provider's rolling usage window resets. Delivery always waits for the session to be idle. The
queue lives on the daemon host, so it survives app reloads, daemon restarts and a closed app.
Success is a message that arrives exactly once, at the moment the developer expected, into the
session they chose, and a developer who never has to wonder what is queued or when it goes.

## Positioning

Defer is the only Paseo plugin that schedules arbitrary messages to any session, including "at the
next usage reset", with idle-aware delivery and a durable, inspectable queue. *(inferred)* Neighbouring
plugins (usage auto-resume, Session Guard) resume work after a limit; Defer sends what you wrote.

## Operating Context

- Entry points: on Paseo 0.16 a control in each session's composer toolbar (a dialog; a sheet on phones), on older Paseo the composer pill above the message box (popover), `/defer 2h <message>`
  in the composer, ⌘K **Defer a message**, the **Deferred** sidebar screen for every session, and the
  agent tools `defer_list_messages` / `defer_schedule_message`.
- Each queued message gets a timeline row in its session's chat that updates in place and disappears
  once sent or cancelled; the delivered message carries a Deferral details attachment.
- Workspaces with something queued get a blue **Deferred** workspace label.
- Used on desktop, web and phones; the phone layout matters (pill popovers become bottom sheets).

## Capabilities and Constraints

- Triggers: `after` (15m / 1h / 3h presets or a typed wait, 1 minute to 30 days), `at` (a local
  clock time, 12- or 24-hour by device), `sessionReset` (anchored to the provider window end, with
  60 s of slack because providers re-derive it on every read).
- Delivery: a 15 s scheduler; never into a running turn; a crash mid-send fails closed rather than
  risk a duplicate.
- Edit, Send now (reschedule to now, still idle-gated), Cancel (kept in history), Delete (timeline),
  Clear history.
- Composer drafts move into Defer on Paseo 0.16: the live prompt is read through the host's
  composer controls and the prompt box is emptied once the message is queued, only while it still
  holds exactly the taken text. On older Paseo they are copied (desktop and web only) and the user
  clears the prompt box.
- Paseo ≥ 0.14. No runtime dependencies. Versioned `queue.json` / `settings.json` under
  `$PASEO_HOME/plugin-data/defer`; schema changes need migrations.

## Brand Commitments

Part of Tom Gringauz's Paseo plugin family (Follow-up, Smart Session, Transfer, Vitals, …): native
to Paseo, host theme tokens only, the shared slate icon tile, plain short copy.

## Evidence on Hand

Screenshots and media use synthetic workspaces and messages from an isolated harness. There are no
user quotes, metrics or testimonials; none may be invented.

## Product Principles

- Say exactly when. Every timing choice resolves to a named day and clock time before it is queued,
  and every queued message shows its time wherever it appears.
- Never surprise the session. Idle-only delivery, at most once, and an edit never silently restarts
  a countdown.
- The queue is visible where you work: the pill, the chat row and the sidebar agree on the next send.
- Undo is always one press: snooze, send now, edit, or cancel from wherever the message is shown.
