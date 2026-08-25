# paseo-defer

[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.5.1-8A63D2?style=for-the-badge)](https://paseo.sh)
[![Release](https://img.shields.io/github/v/release/tomgrin10/paseo-defer?display_name=tag&sort=semver&style=for-the-badge&label=release&color=6366f1)](https://github.com/tomgrin10/paseo-defer/releases/latest)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-defer?style=for-the-badge&color=2563eb)](LICENSE)

A trusted local [Paseo](https://paseo.sh) plugin for queuing a message to an agent and delivering it later.

Messages can be deferred until:

- a relative delay has elapsed;
- a specific local time; or
- the Claude rolling usage window resets.

When a message becomes due, paseo-defer waits for the target agent to become idle so it arrives as a new message instead of steering an active turn. The queue persists across plugin reloads and Paseo restarts.

## Install

Requires Paseo 0.5.1 or newer with plugins enabled. Paseo's plugin API is experimental. This plugin uses an internal Paseo client API to read provider usage windows, so a future Paseo release may require an update.

### Curl

Install the pinned `v0.1.0` release into `~/.local/share/paseo-defer`:

```bash
curl -fsSL https://raw.githubusercontent.com/tomgrin10/paseo-defer/v0.1.0/install.sh | sh
```

The installer downloads the tagged source, installs dependencies, runs the verification suite, and registers the plugin with Paseo. It refuses to overwrite an existing installation. Set `PASEO_DEFER_DIR` to choose another destination.

### Git

```bash
git clone https://github.com/tomgrin10/paseo-defer.git
cd paseo-defer
npm ci
npm run verify
paseo plugin install "$PWD"
paseo plugin ls
```

If plugins are disabled, enable them in **Settings → Plugins** before installing. Open an agent, press **⌘K** on macOS or **Ctrl+K** on Windows/Linux, and choose **Defer a message**.

After editing the source:

```bash
npm run verify
paseo plugin reload paseo-defer
```

## Security and data

Paseo plugins are trusted, unsandboxed code. This plugin runs on the daemon machine, connects to the local Paseo daemon, and stores queued message text in:

```text
$PASEO_HOME/plugin-data/defer/queue.json
```

If `PASEO_HOME` is unset, it defaults to `~/.paseo`. Install only after reviewing the source.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
