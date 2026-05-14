#!/usr/bin/env node
//
// openclaw-channel-dmwork shim → forwards to openclaw-channel-octo.
//
// This package has been renamed. The shim exists so that existing scripts
// (e.g., `npx -y openclaw-channel-dmwork install`) continue to work — they
// install the canonical openclaw-channel-octo package as a dependency and
// dispatch the same CLI entry point against process.argv.
//
// The Phase B `runMigration()` flow detects legacy openclaw-channel-dmwork
// installs and migrates them to openclaw-channel-octo automatically — so a
// user running this shim's `install` command ends up on the new plugin.
//
process.stderr.write(
  "[openclaw-channel-dmwork] deprecated: this package has been renamed to " +
  "openclaw-channel-octo. The CLI invocation will be forwarded; please update " +
  "your scripts to use `npx -y openclaw-channel-octo` directly.\n",
);

const { main } = await import("openclaw-channel-octo/cli");
main();
