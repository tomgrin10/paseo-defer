# paseo-defer

[![npm version](https://img.shields.io/npm/v/paseo-defer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-defer)
[![npm downloads](https://img.shields.io/npm/dm/paseo-defer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-defer)
[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.14.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-defer?style=for-the-badge&color=2563eb)](LICENSE)

Queue a message for an agent and send it later: after a delay, at a set time, or when your usage window resets. Messages wait until the agent is idle, and the queue survives reloads, restarts and a closed app.

![Defer popover with a message and timing controls](docs/defer-popover.png)

## Install

```sh
paseo plugin install paseo-defer
```

## Use

Press the **Defer** pill above a session's composer, or choose **Defer a message** from ⌘K / Ctrl+K. Pick a delay (`15m`, `1h`, `3h`, or up to 30 days), a local time, or **Session reset**. You can also schedule from the composer:

```text
/defer 2h ship the release notes
/defer 9:30 pm review the changes
/defer reset continue the task
```

- Reopen the popover to edit or cancel. The **Deferred** sidebar shows the queue across all sessions.
- Each queued message gets a timeline card with **Edit** and **Delete**, and its workspace gets a blue **Deferred** label until the queue empties.
- Sent messages carry a **Deferral details** attachment with the scheduled and actual send times. The message text is unchanged.
- Agents can list their queue and schedule their own follow-ups with `defer_list_messages` and `defer_schedule_message`. They cannot target other agents.

On desktop and web, opening Defer copies your composer draft, so clear the original to avoid sending it twice. **Settings → Plugins → Defer** can show the pill only while messages are waiting and hide the sidebar entry.

## Data and access

Paseo plugins run trusted, unsandboxed code on the daemon host. Queued messages and settings live in `$PASEO_HOME/plugin-data/defer/`. For password-protected daemons, the plugin reads `PASEO_PASSWORD`, then `PASEO_PASSWORD_FILE`, then `~/paseo-hub/secrets/daemon-password`, and never logs or stores it.

## Development

```sh
npm ci
npm run verify
paseo plugin install .
paseo plugin reload paseo-defer   # after changes
```

## License

[MIT](LICENSE) © 2026 Tom Gringauz.

## Other plugins

- [Follow-up](https://github.com/tomgrin10/paseo-follow-up) — Track workspace PRs, remaining tasks and completion.
- [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) — Send GitHub and Graphite PRs to Paseo from Chrome.
- [Session Guard](https://github.com/tomgrin10/paseo-session-guard) — Pause at session limits and continue after reset.
- [Smart Session](https://github.com/tomgrin10/paseo-smart-session) — Context compaction and usage insights.
- [Transcript Search](https://github.com/tomgrin10/paseo-transcript-search) — Search conversations across connected hosts.
- [Transfer](https://github.com/tomgrin10/paseo-transfer) — Copy or move workspaces between hosts.
- [Vitals](https://github.com/tomgrin10/paseo-vitals) — Host, process, agent and Docker monitoring.
- [Workspace Switcher](https://github.com/tomgrin10/paseo-switcher) — Arc-style Ctrl+Tab between recent workspaces.
