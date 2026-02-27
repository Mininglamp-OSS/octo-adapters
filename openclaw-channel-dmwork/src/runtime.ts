import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setDmworkRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getDmworkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("DMWork runtime not initialized");
  }
  return runtime;
}
