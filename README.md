# paseo-defer

[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.7.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![Release](https://img.shields.io/github/v/release/tomgrin10/paseo-defer?display_name=tag&sort=semver&style=for-the-badge&label=release&color=6366f1)](https://github.com/tomgrin10/paseo-defer/releases/latest)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-defer?style=for-the-badge&color=2563eb)](LICENSE)

A trusted local [Paseo](https://paseo.sh) plugin for queuing a message to an agent and delivering it later.

![The Defer pill above the composer opening the Defer panel, a message queued for delivery in three hours, and the pill counting down with a preview card of what is waiting](docs/defer-panel.gif)

Messages can be deferred until:

- a relative delay has elapsed;
- a specific local time; or
- the Claude rolling usage window resets.

When a message becomes due, paseo-defer waits for the target agent to become idle so it arrives as a new message instead of steering an active turn. The queue lives on the daemon, so it persists across plugin reloads, Paseo restarts, and every client you connect — nothing is lost when you close the app.

### Where it shows up

- **A composer pill**, on every session, beside Paseo's own task and subagent pills. It reads `Defer` while the session has nothing waiting, and pressing it opens the panel — no command centre needed. Once something is queued it becomes the status (`in 12m`, or `2 deferred`), and hovering or pressing it previews the waiting messages without leaving the transcript: press the pill again to put the preview away, or press the preview itself to open the panel. The label turns amber once a message is overdue because the session is mid-turn.
  Under **Composer pill** in either Defer view you can switch it to **Only when waiting**, which keeps the composer clear until something is actually queued.
- **The Defer panel**, as a workspace tab or in Explorer. It names the session it is queueing for — title, workspace, provider, status, and session id — and a waiting message can still be edited (text, timing, or both) until delivery starts. Pressing **Defer** returns you to the session and confirms the delivery time in a toast, so queueing something never costs you your place.
- **The Deferred sidebar surface**, which does the same across every session, with a picker for choosing the target and an **Open session** action that jumps to the session a message will land in.
- **⌘K / Ctrl+K**, as **Defer a message**.

## Install

Requires Paseo 0.7.0 or newer with plugins enabled — enable them in **Settings → Plugins** first if they are off.

```bash
paseo plugin add tomgrin10/paseo-defer
```

That is the whole install. Paseo clones the repository on the daemon machine, compiles it, and starts it: no package manager runs, and the plugin needs no installed dependencies. Pin a tag with `--ref v1.0.0`.

Then open a session and press the **Defer** pill above the composer, or press **⌘K** (**Ctrl+K** on Windows/Linux) and choose **Defer a message**.

```bash
paseo plugin ls                  # confirm it is running
paseo plugin update paseo-defer  # later, pull the newest version
paseo plugin remove paseo-defer
```

<details>
<summary>From a local checkout, for developing against it</summary>

```bash
git clone https://github.com/tomgrin10/paseo-defer.git
cd paseo-defer
npm ci
npm run verify
paseo plugin install "$PWD"
```

After editing the source, `npm run verify && paseo plugin reload paseo-defer`.

</details>

Paseo only offers agent-context commands while the focused tab is a live session, so a new tab that has not started its agent yet shows **Defer a message to a session** instead — it opens the **Deferred** surface, where the target session is picked explicitly.

## Security and data

Paseo plugins are trusted, unsandboxed code. This plugin runs on the daemon machine, connects to the local Paseo daemon, and stores queued message text in:

```text
$PASEO_HOME/plugin-data/defer/queue.json
$PASEO_HOME/plugin-data/defer/settings.json
```

If `PASEO_HOME` is unset, it defaults to `~/.paseo`. Install only after reviewing the source.

Delivery and the Claude usage-window read both go through Paseo's own daemon client, which the plugin borrows from the host at runtime rather than bundling. That is what lets `paseo plugin add` work without a package manager, and it keeps the plugin's protocol version identical to the daemon's. Paseo's public plugin SDK does not expose `provider.usage.list`, so this is the only route to the rolling usage window.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
