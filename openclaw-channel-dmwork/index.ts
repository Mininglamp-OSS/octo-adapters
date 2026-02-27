/**
 * openclaw-channel-dmwork
 *
 * OpenClaw channel plugin for DMWork messaging platform.
 * Connects via WuKongIM WebSocket for real-time messaging.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { dmworkPlugin } from "./src/channel.js";
import { setDmworkRuntime } from "./src/runtime.js";

const plugin: {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "dmwork",
  name: "DMWork",
  description: "OpenClaw DMWork channel plugin via WuKongIM WebSocket",
  register(api) {
    setDmworkRuntime(api.runtime);
    api.registerChannel({ plugin: dmworkPlugin });
  },
};

export default plugin;
