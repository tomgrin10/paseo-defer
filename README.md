# paseo-defer

[![npm version](https://img.shields.io/npm/v/paseo-defer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-defer)
[![npm downloads](https://img.shields.io/npm/dm/paseo-defer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-defer)
[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.10.1-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-defer?style=for-the-badge&color=2563eb)](LICENSE)

Queue a message for a later time or your agent's usage-window reset.

![Defer popover with a message and timing controls](docs/defer-popover.png)

## Install

Use the latest [Paseo](https://paseo.sh) release:

```sh
paseo plugin install paseo-defer
```

For Git installs:

```sh
paseo plugin add https://github.com/tomgrin10/paseo-defer.git --ref v2.4.0
```

Update with `paseo plugin update paseo-defer`.

## Use

- Press the **Defer** pill above a session's composer, or choose **Defer a message** from **⌘K / Ctrl+K**.
- Pick a delay (`15m`, `1h`, `3h`, or a custom wait up to 30 days), a local time, or **Session reset**. Bare numbers mean minutes; times follow your device's clock format.
- Reopen the popover to add, edit, or cancel messages. The **Deferred** sidebar shows the queue across all sessions.

You can also schedule directly from the composer:

```text
/defer 2h ship the release notes
/defer 9:30 pm review the changes
/defer reset continue the task
```

Messages wait until the agent is idle. The queue persists across reloads and restarts, even when you close the app.

Workspaces with waiting or sending messages get a blue **Deferred** label in the left sidebar. It stays until the workspace's last deferred message is sent, cancelled, or fails. Labels are restored after restarts, follow sessions moved to another workspace, and preserve other workspace labels, including Session Guard's **Paused** label.

A **Deferred message** timeline card shows the queued text and delivery time. Use **Edit** on the card to change its message or schedule, or **Delete** to remove it. Saving text alone preserves the original delivery time. Sending, cancelling, or deleting removes the card from view; failed sends can also be deleted.

On Paseo apps with the timeline-footer API, deferred cards stay pinned below the scrollable chat history, above the composer. They remain available while older messages load, without duplicate inline cards. Current apps keep the editable inline card until that app support ships.

Sent messages include a **Deferral details** context attachment: when queued, the intended delivery time and trigger, the usage-window reset when applicable, the actual send time, and elapsed/late duration. The original message text stays unchanged.

On desktop and web, opening Defer copies your composer draft. Clear the original yourself to avoid sending it twice. On iOS, enter the message in Defer.

Under **Composer pill**, choose **Only when waiting** to hide the pill when the queue is empty.

On Paseo 0.10.1+, hide the sidebar entry in **Settings → Plugins → Defer → Display**; Command Center access stays available after opening a workspace or plugin on that host.

## Data and access

Paseo plugins run trusted, unsandboxed code on the daemon host. Queued messages and settings stay in `$PASEO_HOME/plugin-data/defer/` (`~/.paseo` by default).

For password-protected daemons, the plugin reads `PASEO_PASSWORD`, then `PASEO_PASSWORD_FILE`, then `~/paseo-hub/secrets/daemon-password`. It never logs or stores the password.

## Development

```sh
git clone https://github.com/tomgrin10/paseo-defer.git
cd paseo-defer
npm ci
npm run verify
paseo plugin install "$PWD"
```

After changes, run `npm run verify` and `paseo plugin reload paseo-defer`.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.

## Other plugins

- [Graphite](https://github.com/tomgrin10/paseo-graphite) — Graphite stacks and PR status.
- [Smart Session](https://github.com/tomgrin10/paseo-smart-session) — Context compaction and usage insights.
- [Vitals](https://github.com/tomgrin10/paseo-vitals) — Host, agent, and Docker health.
- [Session Guard](https://github.com/tomgrin10/paseo-session-guard) — Pause at session limits and continue after reset.
- [Transfer](https://github.com/tomgrin10/paseo-transfer) — Copy or move workspaces between hosts.
- [Transcript Search](https://github.com/tomgrin10/paseo-transcript-search) — Search conversations across connected hosts.
- [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) — Send GitHub and Graphite PRs to Paseo from Chrome.
- [Dispatch](https://github.com/tomgrin10/paseo-dispatch) — Route tasks to existing workspaces (development preview).
