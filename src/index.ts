#!/usr/bin/env node
/**
 * Stdio entrypoint: the transport used when an MCP client (Claude Code, Claude
 * Desktop) launches this server as a child process. For a hosted deployment
 * that remote clients reach over HTTPS, see http.ts.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { KeapClient } from "./client.js";
import { endpoints } from "./catalog.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    // stderr only — stdout is the MCP transport.
    console.error(
      "keapmcp: no KEAP_PAT found. Add it to .env in the project root. Tools will report this too.",
    );
  }
  const server = createServer(new KeapClient(config), config);
  await server.connect(new StdioServerTransport());
  console.error(`keapmcp ready — ${endpoints.length} Keap read endpoints available`);
}

main().catch((error) => {
  console.error("keapmcp failed to start:", error);
  process.exit(1);
});
