#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { Gateway } from "./gateway.js";

const config = loadConfig();
const gateway = new Gateway(config);

// Graceful shutdown
process.on("SIGINT", () => {
  gateway.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  gateway.stop();
  process.exit(0);
});

gateway.start().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
