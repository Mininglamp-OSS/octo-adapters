/**
 * openclaw-channel-dmwork
 *
 * OpenClaw channel plugin for DMWork messaging platform.
 * Connects via WuKongIM WebSocket for real-time messaging.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { dmworkPlugin } from "./src/channel.js";
import { setDmworkRuntime } from "./src/runtime.js";
import { getGroupMdForPrompt } from "./src/group-md.js";
import {
  inProcessConfigReader,
  runDoctorChecks,
  formatDoctorResult,
} from "./cli/doctor.js";

const plugin: {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "openclaw-channel-dmwork",
  name: "DMWork",
  description: "OpenClaw DMWork channel plugin via WuKongIM WebSocket",
  register(api) {
    setDmworkRuntime(api.runtime);
    api.registerChannel({ plugin: dmworkPlugin });

    api.registerCommand({
      name: "dmwork_doctor",
      description: "Check DMWork plugin status and connectivity",
      acceptsArgs: true,
      async handler(ctx) {
        const reader = inProcessConfigReader(ctx.config);
        const result = await runDoctorChecks({
          reader,
          accountId: ctx.args?.trim() || undefined,
          inProcess: true,
        });
        return { text: formatDoctorResult(result) };
      },
    });

    console.log('[dmwork] registering before_prompt_build hook');
    api.on('before_prompt_build', (_event, ctx) => {
      const content = getGroupMdForPrompt(ctx);
      if (!content) return;
      const result = { prependContext: `[GROUP CONTEXT]\n${content}\n[/GROUP CONTEXT]` };
      return result;
    });
  },
};

export default plugin;
