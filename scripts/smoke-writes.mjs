#!/usr/bin/env node
/**
 * Offline check of the password-gated write tools. Starts a fake Keap API on
 * localhost, points the built server at it, and verifies the password gate,
 * lockout, DELETE gating and the exact requests each tool sends. Never
 * contacts the real Keap account.
 */
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = "correct horse battery staple";

const seen = [];
const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "999", echo: body ?? null }));
  });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${fake.address().port}/crm`;

async function connect(extraEnv) {
  const client = new Client({ name: "keapmcp-smoke-writes", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist/index.js")],
      cwd: root,
      env: { ...process.env, KEAP_PAT: "fake", KEAP_BASE_URL: base, KEAP_WRITE_PASSWORD: "", ...extraEnv },
      stderr: "ignore",
    }),
  );
  return client;
}

let failures = 0;
function expect(label, condition, detail = "") {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}  ${detail}`);
  }
}
const textOf = (r) => r.content?.[0]?.text ?? "";
const last = () => seen[seen.length - 1];

// 1. No password configured: no write tools at all.
{
  const client = await connect({});
  const { tools } = await client.listTools();
  expect("read-only when no password set", !tools.some((t) => t.name.startsWith("keap_create") || t.name === "keap_write"));
  await client.close();
}

// 2. Password configured.
const client = await connect({ KEAP_WRITE_PASSWORD: PASSWORD });
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
expect("write tools registered", ["keap_create_contact", "keap_create_tag", "keap_create_tag_category", "keap_tag_contacts", "keap_write"].every((n) => names.includes(n)), names.join(","));

const call = (name, args) => client.callTool({ name, arguments: args });

let r = await call("keap_create_tag", { name: "VIP" });
expect("missing password refused", r.isError && /needs the write password/.test(textOf(r)), textOf(r));
expect("nothing sent without password", seen.length === 0);

r = await call("keap_create_tag", { name: "VIP", password: "wrong" });
expect("wrong password refused", r.isError && /Wrong write password/.test(textOf(r)), textOf(r));
expect("nothing sent with wrong password", seen.length === 0);

r = await call("keap_create_tag", { name: "VIP", category_id: 7, password: PASSWORD });
expect("create tag", !r.isError && last()?.method === "POST" && last().url === "/crm/rest/v2/tags" && last().body.category.id === "7", JSON.stringify(last()));

r = await call("keap_create_tag_category", { name: "Lifecycle", password: PASSWORD });
expect("create tag category", !r.isError && last().url === "/crm/rest/v2/tags/categories" && last().body.name === "Lifecycle", JSON.stringify(last()));

const before = seen.length;
r = await call("keap_create_contact", { given_name: "Sam", email: "sam@example.com", tag_ids: ["11", "12"], duplicate_option: "Email", password: PASSWORD });
const created = seen[before];
expect("create contact", !r.isError && created.url === "/crm/rest/v2/contacts?duplicate_option=Email" && created.body.email_addresses[0].email === "sam@example.com", JSON.stringify(created));
expect("tags applied after create", seen.length === before + 3 && seen[before + 1].url === "/crm/rest/v2/tags/11/contacts:applyTags" && seen[before + 1].body.contact_ids[0] === "999", JSON.stringify(seen.slice(before)));

r = await call("keap_update_contact", { contact_id: 5, fields: { given_name: "Sammy", job_title: "CEO" }, password: PASSWORD });
expect("update contact with mask", !r.isError && last().method === "PATCH" && last().url === "/crm/rest/v2/contacts/5?update_mask=given_name%2Cjob_title", JSON.stringify(last()));

r = await call("keap_tag_contacts", { action: "remove", tag_ids: [3], contact_ids: [1, 2, 2], password: PASSWORD });
expect("remove tags", !r.isError && last().url === "/crm/rest/v2/tags/3/contacts:removeTags" && last().body.contact_ids.length === 2, JSON.stringify(last()));

const countBefore = seen.length;
r = await call("keap_write", { endpoint: "v2.updateTag", params: { tag_id: "3" }, body: { name: "VIP+" }, dry_run: true });
expect("dry run needs no password and sends nothing", !r.isError && seen.length === countBefore && /"method": "PATCH"/.test(textOf(r)), textOf(r));

r = await call("keap_write", { endpoint: "v2.updateTag", params: { tag_id: "3" }, body: { name: "VIP+" }, password: PASSWORD });
expect("generic write", !r.isError && last().method === "PATCH" && last().url === "/crm/rest/v2/tags/3", JSON.stringify(last()));

r = await call("keap_write", { endpoint: "v2.deleteTag", params: { tag_id: "3" }, password: PASSWORD });
expect("DELETE disabled by default", r.isError && /deletes are disabled/.test(textOf(r)), textOf(r));

r = await call("keap_find_write_endpoints", { endpoint: "v2.createTag" });
expect("describe write endpoint", !r.isError && /"category"/.test(textOf(r)));

// Lockout: wrong password repeatedly locks out even the right one.
for (let i = 0; i < 5; i++) await call("keap_create_tag", { name: "x", password: `bad${i}` });
const lockedCount = seen.length;
r = await call("keap_create_tag", { name: "x", password: PASSWORD });
expect("lockout after repeated failures", r.isError && /locked/.test(textOf(r)) && seen.length === lockedCount, textOf(r));

await client.close();
fake.close();
console.log(failures ? `\n${failures} failure(s)` : "\nall write checks passed");
process.exit(failures ? 1 : 0);
