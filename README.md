# paseo-defer

[![npm version](https://img.shields.io/npm/v/paseo-defer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-defer)
[![npm downloads](https://img.shields.io/npm/dm/paseo-defer?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-defer)
[![Paseo](https://img.shields.io/badge/Paseo-plugin-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-defer?style=for-the-badge&color=2563eb)](LICENSE)

Queue a message for a later time or your agent's usage-window reset.

![Defer popover with a message and timing controls](docs/defer-popover.png)

## Install

Use the latest [Paseo](https://paseo.sh) release:

```sh
paseo plugin install paseo-defer
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

On desktop and web, opening Defer copies your composer draft. Clear the original yourself to avoid sending it twice. On iOS, enter the message in Defer.

Under **Composer pill**, choose **Only when waiting** to hide the pill when the queue is empty.

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

## More Paseo plugins

- [Graphite](https://github.com/tomgrin10/paseo-graphite) — Graphite stacks and PR status.
- [Smart Session](https://github.com/tomgrin10/paseo-smart-session) — Context compaction and usage insights.
- [Vitals](https://github.com/tomgrin10/paseo-vitals) — Host, agent, and Docker health.
- [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) — Send PRs to Paseo from Chrome.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
