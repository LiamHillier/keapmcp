#!/usr/bin/env node
/**
 * End-to-end check of the HTTP entrypoint: starts dist/http.js on a spare
 * port with a throwaway secret, then verifies auth handling and that a real
 * MCP client can list tools, call one, and receive progress notifications.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 20000 + Math.floor(Math.random() * 20000);
const secret = randomBytes(24).toString("hex");
const base = `http://127.0.0.1:${port}`;
const mcpUrl = new URL(`${base}/mcp`);

const child = spawn(process.execPath, [join(root, "dist/http.js")], {
  cwd: root,
  env: { ...process.env, KEAP_MCP_PORT: String(port), KEAP_MCP_HOST: "127.0.0.1", KEAP_MCP_AUTH_TOKEN: secret },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));

let failures = 0;
function report(ok, label, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return res.json();
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited early:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy:\n${stderr}`);
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

try {
  const health = await waitForHealth();
  report(health.ok === true, "healthz", `${health.read_endpoints} endpoints`);

  let res = await fetch(mcpUrl, { method: "POST", headers: mcpHeaders, body: initialize });
  report(res.status === 401, "no token rejected", `status ${res.status}`);
  report(/bearer/i.test(res.headers.get("www-authenticate") ?? ""), "401 advertises Bearer scheme");

  res = await fetch(mcpUrl, {
    method: "POST",
    headers: { ...mcpHeaders, authorization: `Bearer ${secret}x` },
    body: initialize,
  });
  report(res.status === 401, "wrong token rejected", `status ${res.status}`);

  res = await fetch(mcpUrl, { method: "GET", headers: { ...mcpHeaders, authorization: `Bearer ${secret}` } });
  report(res.status === 405, "GET rejected in stateless mode", `status ${res.status}`);

  res = await fetch(`${base}/nope`, { method: "POST", headers: mcpHeaders, body: initialize });
  report(res.status === 404, "unknown path rejected", `status ${res.status}`);

  const client = new Client({ name: "keapmcp-smoke-http", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    }),
  );
  const { tools } = await client.listTools();
  report(tools.length === 6, "tools/list over HTTP", tools.map((t) => t.name).join(", "));

  const body = (r) => {
    try {
      return JSON.parse(r.content?.[0]?.text ?? "");
    } catch {
      return r.content?.[0]?.text;
    }
  };

  const who = await client.callTool({ name: "keap_whoami", arguments: {} });
  const whoBody = body(who);
  report(!who.isError && whoBody.connected === true, "keap_whoami over HTTP", who.isError ? whoBody : whoBody.account?.name);

  let progressEvents = 0;
  const started = Date.now();
  const rev = await client.callTool(
    { name: "keap_report", arguments: { report: "revenue", since: "2026-01-01", period: "month", max_records: 2000 } },
    undefined,
    { onprogress: () => progressEvents++, timeout: 120_000 },
  );
  report(!rev.isError, "keap_report revenue over HTTP", `${Date.now() - started}ms`);
  report(progressEvents > 0, "progress notifications streamed", `${progressEvents} event(s)`);

  await client.close();
} catch (error) {
  failures++;
  console.log(`FAIL  ${error.message}`);
} finally {
  child.kill("SIGTERM");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall HTTP checks passed");
process.exit(failures ? 1 : 0);
