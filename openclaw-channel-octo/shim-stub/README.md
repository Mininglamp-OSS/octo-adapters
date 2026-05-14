# openclaw-channel-dmwork (deprecated)

**This package has been renamed to [`openclaw-channel-octo`](https://www.npmjs.com/package/openclaw-channel-octo).**

This shim package forwards all CLI invocations to `openclaw-channel-octo`, so
existing scripts and BotFather instructions like:

```
npx -y openclaw-channel-dmwork install
npx -y openclaw-channel-dmwork bind --bot-token ... --api-url ...
```

continue to work without any changes — they install the canonical
`openclaw-channel-octo` package and dispatch the same CLI entry point.

## How the migration works

When you run `npx -y openclaw-channel-dmwork install`:

1. npm/npx installs this shim package, which depends on
   `openclaw-channel-octo` and pulls in the canonical package.
2. The shim's bin entry forwards `process.argv` to
   `openclaw-channel-octo`'s CLI via `import("openclaw-channel-octo/cli")`.
3. `openclaw-channel-octo install` detects the legacy
   `openclaw-channel-dmwork` plugin (or `channels.dmwork` / bindings residue)
   on disk and runs the rebrand migration, transferring all bot config and
   bindings to the new `channels.octo` namespace.

After migration, the legacy `openclaw-channel-dmwork` plugin is uninstalled
and the user is fully on `openclaw-channel-octo`.

## Migration timeline

- **1.0.x** — this shim is published alongside every
  `openclaw-channel-octo` release.
- **A future minor release** — this shim will be marked
  `npm deprecate`d and stop receiving new versions.
- **A future major release** — this shim will no longer be published.

Please update your installation scripts to use `npx -y openclaw-channel-octo`
directly to avoid the forwarding overhead.
