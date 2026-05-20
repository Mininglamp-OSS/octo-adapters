import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DmworkConfigJsonSchema } from "./config-schema.js";

// Regression guard for OpenClaw v2026.5.x channel manifest requirement:
// openclaw.plugin.json#channelConfigs.octo.schema must stay in sync
// with DmworkConfigJsonSchema, otherwise the Control UI / config validator
// and the runtime zod pipeline disagree.

describe("openclaw.plugin.json channelConfigs", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "..", "openclaw.plugin.json"), "utf-8"),
  );

  it("declares channelConfigs.octo.schema", () => {
    expect(manifest.channelConfigs?.octo?.schema).toBeDefined();
  });

  it("manifest schema properties match DmworkConfigJsonSchema properties", () => {
    const manifestProps = manifest.channelConfigs.octo.schema.properties;
    const tsProps = DmworkConfigJsonSchema.schema.properties;
    // Key-level compare — catches additions/removals on either side
    expect(Object.keys(manifestProps).sort()).toEqual(Object.keys(tsProps).sort());
  });

  it("manifest accounts schema matches DmworkConfigJsonSchema accounts", () => {
    const manifestAccountProps =
      manifest.channelConfigs.octo.schema.properties.accounts.additionalProperties.properties;
    const tsAccountProps =
      (DmworkConfigJsonSchema.schema.properties.accounts as any).additionalProperties.properties;
    expect(Object.keys(manifestAccountProps).sort()).toEqual(
      Object.keys(tsAccountProps).sort(),
    );
  });
});

// Regression for PR #35 review: onBehalfOf must reject whitespace-only /
// empty-string typos at config validation time (`minLength: 1`).
describe("openclaw.plugin.json onBehalfOf validation", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "..", "openclaw.plugin.json"), "utf-8"),
  );

  it("top-level onBehalfOf has minLength: 1", () => {
    expect(
      manifest.channelConfigs.octo.schema.properties.onBehalfOf.minLength,
    ).toBe(1);
  });

  it("per-account onBehalfOf has minLength: 1", () => {
    const accountProps =
      manifest.channelConfigs.octo.schema.properties.accounts
        .additionalProperties.properties;
    expect(accountProps.onBehalfOf.minLength).toBe(1);
  });

  it("TS-side DmworkConfigJsonSchema mirrors minLength: 1", () => {
    const props = DmworkConfigJsonSchema.schema.properties as any;
    expect(props.onBehalfOf.minLength).toBe(1);
    const accountProps = props.accounts.additionalProperties.properties;
    expect(accountProps.onBehalfOf.minLength).toBe(1);
  });

  // Jerry-Xin R2 P1: minLength alone accepts whitespace-only typos like
  // "   " (each space counts as a character). Adding `pattern: "\\S"`
  // requires at least one non-whitespace character.
  it("top-level onBehalfOf has pattern \\S to reject whitespace-only values", () => {
    expect(
      manifest.channelConfigs.octo.schema.properties.onBehalfOf.pattern,
    ).toBe("\\S");
  });

  it("per-account onBehalfOf has pattern \\S to reject whitespace-only values", () => {
    const accountProps =
      manifest.channelConfigs.octo.schema.properties.accounts
        .additionalProperties.properties;
    expect(accountProps.onBehalfOf.pattern).toBe("\\S");
  });

  it("TS-side DmworkConfigJsonSchema mirrors pattern \\S", () => {
    const props = DmworkConfigJsonSchema.schema.properties as any;
    expect(props.onBehalfOf.pattern).toBe("\\S");
    const accountProps = props.accounts.additionalProperties.properties;
    expect(accountProps.onBehalfOf.pattern).toBe("\\S");
  });
});
