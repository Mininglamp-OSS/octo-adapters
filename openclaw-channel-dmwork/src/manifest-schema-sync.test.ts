import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DmworkConfigJsonSchema } from "./config-schema.js";

// Regression guard for OpenClaw v2026.5.x channel manifest requirement:
// openclaw.plugin.json#channelConfigs.dmwork.schema must stay in sync
// with DmworkConfigJsonSchema, otherwise the Control UI / config validator
// and the runtime zod pipeline disagree.

describe("openclaw.plugin.json channelConfigs", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "..", "openclaw.plugin.json"), "utf-8"),
  );

  it("declares channelConfigs.dmwork.schema", () => {
    expect(manifest.channelConfigs?.dmwork?.schema).toBeDefined();
  });

  it("manifest schema properties match DmworkConfigJsonSchema properties", () => {
    const manifestProps = manifest.channelConfigs.dmwork.schema.properties;
    const tsProps = DmworkConfigJsonSchema.schema.properties;
    // Key-level compare — catches additions/removals on either side
    expect(Object.keys(manifestProps).sort()).toEqual(Object.keys(tsProps).sort());
  });

  it("manifest accounts schema matches DmworkConfigJsonSchema accounts", () => {
    const manifestAccountProps =
      manifest.channelConfigs.dmwork.schema.properties.accounts.additionalProperties.properties;
    const tsAccountProps =
      (DmworkConfigJsonSchema.schema.properties.accounts as any).additionalProperties.properties;
    expect(Object.keys(manifestAccountProps).sort()).toEqual(
      Object.keys(tsAccountProps).sort(),
    );
  });
});
