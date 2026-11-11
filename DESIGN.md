# Paseo native surface

Defer extends Paseo's existing interface. It inherits the host theme, system type, controls, icon names and platform layout, and adds one signature: a deferred message is shown as a time. Wherever it appears it leads with the clock it sends at in tabular figures, the countdown beside it in muted text, and a timer glyph whose ring drains as the wait runs out. The pill, the sidebar row, the chat card and the Deferred screen all name the same next send ("2 · 4:42 PM"). Visitor mode: Operate.

## Tokens

Use only `theme.colors.surface0`, `surface1`, `surface2`, `border`, `foreground`, `foregroundMuted`, `accent`, `accentForeground`, `statusSuccess`, `statusWarning` and `statusDanger`, through `client/theme.ts` (shared with Follow-up):

- `raised(colors)`: cards in light themes get a hairline ring plus a soft lift (`0 0 0 1px rgba(0,0,0,.07), 0 1px 2px -1px rgba(0,0,0,.06), 0 2px 6px rgba(0,0,0,.04)`). In dark themes they get one 8% white ring. Dividers inside a card are 1px `border` hairlines.
- `tint(color)`: count chips are filled with their own hue at 12% (light) or 16% (dark).
- `toneColor(colors, tone)`: maps an outcome to a colour.
- `tabular`: tabular numerals on every time, countdown and count.

Colour carries outcome and nothing else. Green means sent. Red means failed or not sent. Muted covers pending, cancelled (the developer's own choice) and unknown. Amber appears only in the usage bar, from 80% of the window used (red from 95%). Accent belongs to the primary **Defer** / **Save changes** button alone. Selection never uses accent: a selected timing chip or session row is `surface2` with a `foreground` ring (chips) or fill (rows) and semibold text.

Type is the system sans, with sizes defined in `kit.tsx`'s `text` scale. Panel titles are 15/21 semibold. Body is 13/19. Muted meta and hints are 12/17. Small labels are 11/15. Group headings are 12/16 semibold muted. The send time is semibold tabular: 14/19 in list rows and 15/21 on the chat card. The countdown sits beside it at 12/17 muted. The Deferred screen title is 22/29 (19/25 compact). Message text in the chat card is 14/21. Monospace is used only for the `/defer 2h …` example in the empty state.

Controls are 32px (28px small) on desktop with a 4px hit slop, and 44px in compact layouts. They have 6px corners (8px compact). Timing chips are 30px pills (40px compact) and icon buttons are 28px (44px compact). Cards use 10px corners, the chat card 12px, the message box 10px and inline fields 8px. Motion uses the ease-out curve `bezier(0.16, 1, 0.3, 1)` on opacity and transform only, and every animation checks reduced motion. Presses scale to 97% over 140ms. The pill icon cross-fades over 260ms when it changes between idle, timer and sending. Skeletons breathe over 800ms and stay static under reduced motion. Countdowns tick every 15s, or every second inside the last two minutes (`tickFor`).

## The timer glyph and the time line

`TimerGlyph` is a 24-unit stopwatch drawn as inline SVG in the surface's own colour (`timerGlyph(fraction)` in `shared/format.ts`). It has a faint full ring at 32% opacity, a solid arc for the remaining fraction (rounded to 1/24) and a hand at its end. Sending swaps it for the spinner. A due-and-held message, or a reset whose time isn't known yet, shows an hourglass. The glyph is `foreground` while waiting and muted otherwise.

`WhenLine` is how every waiting message starts: glyph, time, then detail. The detail is "in 47m", "tomorrow · in 14h 31m", "at session reset · in 2h 26m" or "due · waits for the agent to finish". A time on its own always means today. Other days get a weekday or "tomorrow" in front. Every clock goes through `formatClock` and follows the device's 12- or 24-hour convention.

`rowActions` is the one action row for a waiting message. On the left are bordered secondary small buttons with icons: **+10m** (TimerReset; omitted for a reset trigger), **Send now** (SendHorizontal) and **Edit** (Pencil). While the message is open in the composer, Edit is replaced by a muted "Editing" and +10m and Send now are disabled. On the right, set apart, is a ghost **Cancel**. A failed message gets **Send again** (RotateCw) and a ghost **Dismiss**. Compact layouts drop the icons and keep 44px targets.

## Composer control (Paseo 0.16)

On a host with `addComposerItem`, a desktop-width window gets Defer as a native composer control, not a pill: Paseo's own `Action`, drawn by the host as an icon in the composer toolbar, or as a titled row in the composer's overflow sheet when a narrow pane leaves no room. A phone keeps the pill (next section) and has no composer control at all: Paseo 0.16 folds every composer item into the overflow sheet behind the model button on a phone, where Defer would be one tap deeper and hard to find. "Phone" is the host's own rule, the compact form factor below 600px (`client/form-factor.ts`), followed live, so a window resized or rotated across it swaps the pill and the control without ever showing both. Its icon is the plain Clock, muted, while nothing waits, and the live `TimerGlyph` in `foreground` once something does, so a waiting queue stands out from the toolbar's muted icons in either theme. Its title (tooltip, accessibility label and sheet row) leads with the action: **Defer a message**, or "Defer · 2 waiting · next 4:42 PM". The toolbar has no text of Defer's own: the count and next time live in that title, the glyph, the chat cards and the sidebar row. Pressing it opens Paseo's `Modal` titled **Defer a message** (or **Edit deferred message**): a dialog on desktop, a bottom sheet on a phone, holding the popover's content without its heading. Desktop content follows the host dialog's own width rather than the popover's 400px column. A small ghost **All deferred** link closes the content, so **Defer** stays the only full-width bar. Asking Paseo to name the agent on `PluginComposer` is drafted upstream. Drafts and New workspace get no control: there is no session to defer to yet.

## Pill and popover (phones on Paseo 0.16, everywhere on 0.15 and older)

The composer pill sits above each session's message box. It reads **Defer** with a plain clock when nothing is waiting. Otherwise it reads the next send: "in 47m" inside the hour, the clock after that ("tmrw 9:30 AM"), "due now", "at reset" or "sending…", with the count in front once there is more than one ("2 · 4:42 PM"). Its icon is the live timer glyph. Its title, used as the tooltip and as the phone sheet's title, is "2 deferred · next 4:42 PM".

The popover is 400px wide (a bottom sheet on phones). It has a "Defer a message" heading (or "Edit deferred message") with a ghost **All deferred** link, then the composer, then a hairline and a "Waiting  N" group of rows for this session without a session link. On phones the heading is dropped and a full-width **All deferred messages** button closes the sheet. Queueing closes the popover, and a toast names the time ("Deferred until 4:42 PM · in 1h").

## Composer

The composer is the same in the popover, the panel, the chat card's edit mode and the New/Edit modals. It opens with a multiline message box: `surface1`, 1px `border`, 10px corners, 84px minimum height (76px compact). Focus raises the border to `foreground` at 42%. Text taken from the session's own prompt box adds a muted Copy-icon note: on Paseo 0.16 it says Defer clears the box once this is queued; on older hosts, to clear it there. Below that is a row of neutral timing chips: **15m**, **1h**, **3h**, **In…**, **At…** and **Session reset · 9:25 PM**. An edit leads with **Keep · 4:42 PM**, selected. **In…** and **At…** open an inline field. **At…** adds AM/PM chips only on a 12-hour device. **Session reset** with a known usage share adds a 4px usage bar. One muted line names the resolved moment as you type ("Sends today at 4:42 PM · in 1h") or explains the format. Errors are a red line. The full-width primary **Defer** finishes the composer. An edit gets a right-aligned ghost **Cancel edit** and primary **Save changes** instead.

## Chat

Each waiting message is a card in its session's chat. On desktop it sits on the right, up to 560px wide, where the message will land. It is full width in compact layouts. The card is `surface1` with `raised` depth, 12px corners and 11/14px padding. Its header is the glyph and time line at 15px, followed by the message (up to 12 lines, selectable) and `rowActions`. Edit swaps the message for the composer in place. A failed card replaces `raised` with a 1px border in `statusDanger` at 60%, a TriangleAlert, "Not sent" in red and the reason muted, with Send again and Dismiss. Sent and cancelled cards disappear. Where the app offers a pinned timeline footer, the same cards are drawn there instead of inline.

Defer's own agent tools render as one quiet line sized like Paseo's tool rows (14px, muted, Clock icon). Examples are "Scheduled a follow-up for 8:38 PM" and "Checked deferred messages · 2 waiting". On hover the icon becomes a chevron. Pressing expands the line into a bordered `surface1` box (240px maximum, scrolling) with the queued message or the queue read. A failure reads in red with a TriangleAlert.

## Deferred screen

The screen is centred at 760px, with 32px padding (16px compact) and 22px between blocks (18px compact). The title is the status: "5 messages waiting" or "Nothing waiting". A secondary **New message** button (**New** compact) and a gear sit on the right. A 13px muted sentence follows the title: "Next 7:25 PM · in 26m · 1 held for a busy agent · Session resets 9:25 PM (86% used)".

Waiting messages are grouped in schedule order under day headings with a count chip: Due now, Today, Tomorrow, a weekday date, and At session reset. Each group is one `raised` card of rows divided by hairlines. A row is the `WhenLine`, then the message in three lines, then the session as a muted "Session · workspace" link with an ArrowUpRight that underlines on hover, then `rowActions`. A closed session reads "Closed session".

**Recent activity** follows, with tinted counts beside the heading ("3 sent · 1 cancelled" in their outcome colours) and a ghost **Clear**. It is one card of rows with a time column (clock over "Today"/"Yesterday"/date, 72px or 62px compact). Each row has the verb in its outcome colour and semibold, with detail muted ("Sent · waited 4m for the agent"), then the message on one line and the session small. Failed rows still tied to an open session offer **Send again**. Six rows show before a "Show all N" fold.

**New message** opens a 480px Paseo `Modal` (a sheet on phones). It has a "To" picker: a bordered list of up to eight sessions, each with a status dot (green working, red error, muted otherwise), title and "workspace · status". Selection is a `surface2` fill with a Check. A filter field appears past six sessions. The composer follows the picker. **Edit** on a row opens the same modal titled "Edit deferred message", with "To Session · workspace" above the composer. Saving an edit never navigates.

## Panel

The per-session panel opens from ⌘K **Defer a message** or from a `/defer` line with no time. It is 600px maximum, with 24px padding (16px compact). Its title is "Defer to Session" with a meta line saying whether the agent is working or idle. The composer comes next, then a "Waiting  N" card and a Recent activity card in the screen's row patterns (the same time column, no session line). Queueing returns to the session's transcript with a toast.

## Settings and sidebar

The sidebar row is Paseo's `SidebarRow` with a Clock icon. Its title is **Deferred**, and the next send trails it in 12px tabular muted text, read from the same live queue as the pill. Settings → Display uses Paseo's settings kit. One "Where Defer appears" section holds a **Composer button** select (Every session, Only while messages wait, Off) with the chosen option's rule as its hint, and a **Sidebar row** switch. An info tip says ⌘K and `/defer` keep working.

## Empty, loading and error

An empty queue is one card. It says "Queue a message for later", explains how in muted text, shows `/defer 2h ship the release notes` in a `surface2` monospace tile, and ends with a meta line saying when messages send. The panel says "Nothing is waiting for this session." Loading shows a card of three skeleton pairs on `surface2`. A failed first load shows a card with "Couldn't read the queue", the error and **Try again**. Data stays on screen during refreshes. Action failures surface as toasts or a red inline line under the card, never by replacing the view.
