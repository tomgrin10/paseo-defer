# Repository instructions

## Project

- This is the trusted, unsandboxed Paseo plugin `paseo-defer`; minimum supported Paseo is 0.5.1.
- Check the current plugin docs at `https://paseo.sh/docs/plugins.md` and `https://paseo.sh/docs/plugins/reference.md` before changing runtime code.
- Never commit credentials, queued messages, daemon configuration, logs, or local paths.

## Code boundaries

- Keep `index.ts` focused on contribution wiring.
- `*.client.tsx`: React Native UI and client hooks. Use `theme.colors` for text/backgrounds and `layout.compact` for responsive spacing.
- `*.server.ts`: Node APIs, filesystem access, daemon connections, and backend behavior.
- `*.shared.ts`: Zod RPC contracts and plain values safe in both runtimes.
- Preserve the versioned queue schema and `$PASEO_HOME/plugin-data/defer` data path; add migrations for incompatible changes.
- Keep daemon connections short-lived and ensure every timer/resource is released by plugin cleanup. Do not log secrets or message bodies.
- Do not edit Paseo daemon config, enable plugins without explicit permission, or restart the daemon to load changes.

## Verify changes

```sh
npm ci
npm run verify
paseo plugin reload paseo-defer
paseo plugin ls
paseo plugin logs paseo-defer
```

Require `paseo-defer` to be `running` without errors. For UI changes, also check desktop/mobile layouts and light/dark themes.

## Create a release

- Release user-facing features, bug fixes, compatibility changes, data migrations, or installer changes. Documentation-only edits normally do not need a release.
- Use SemVer: patch for compatible fixes, minor for backward-compatible features, and major for breaking behavior, storage, or compatibility changes.
- Update the version in `package.json` and its lockfile, plus the pinned version in `install.sh` and the README curl URL. Keep badge styles consistent; update the Paseo minimum only when compatibility changes.
- Release notes must include a short summary, user-visible changes, the pinned curl install command, minimum Paseo version, and any breaking, migration, security, or upgrade considerations. Omit empty sections.
- Before publishing, require a clean current `main`, verified GitHub ownership, passing checks, a successful plugin reload, clean logs, and a secret audit of the exact release snapshot.
- Tag the exact release commit as `vX.Y.Z`; title the release `paseo-defer vX.Y.Z`. After publishing, test the public tag-pinned installer and badge URLs.

Never move or rewrite a published tag. Ship corrections as a new patch release.
