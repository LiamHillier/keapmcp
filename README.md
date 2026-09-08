# keapmcp

An MCP server that gives a chat assistant read-only access to a Keap
(Infusionsoft) CRM account, covering **all 228 read endpoints** of Keap's REST v1
and v2 APIs, plus tools that aggregate and report on that data so you can ask
business questions in plain language.

Read-only by design: only `GET` operations are exposed, so nothing in Keap can be
created, modified or deleted through this server.

## Quick start

```bash
npm install && npm run build
```

Put a Keap Personal Access Token or Service Account Key in `.env`:

```
KEAP_PAT=your_token_here
```

Create one in Keap under **Settings → API Settings**, or see
[Keap's PAT & SAK docs](https://developer.infusionsoft.com/pat-and-sak/).
A PAT acts as the user who created it and sees only what that user can see; a
Service Account Key is admin-scoped.

Verify the connection:

```bash
npm run smoke
```

### Connecting a client

**Claude Code** — `.mcp.json` in this directory already registers the server;
approve it when prompted, or run:

```bash
claude mcp add keap --scope user -- node /path/to/keapmcp/dist/index.js
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "keap": {
      "command": "node",
      "args": ["/path/to/keapmcp/dist/index.js"]
    }
  }
}
```

The server finds `.env` relative to its own location, so it works regardless of
the client's working directory.

### Hosting it remotely

The setups above run the server on the same machine as the client. To run it
once on a server and let Claude Code on any machine use it, start the HTTP
entrypoint instead. It speaks MCP's Streamable HTTP transport, which Claude Code
connects to natively.

On the server:

```bash
git clone <this repo> /opt/keapmcp && cd /opt/keapmcp
npm install && npm run build
```

Put both tokens in `.env`. `KEAP_MCP_AUTH_TOKEN` is a shared secret of your own
choosing that every client must present. The server refuses to start without
it, because whoever reaches this endpoint can read the entire CRM.

```
KEAP_PAT=your_keap_token
KEAP_MCP_AUTH_TOKEN=paste_the_output_of_openssl_rand_-hex_32
```

Then:

```bash
npm run start:http     # listens on http://127.0.0.1:3000/mcp
```

The server binds to loopback and has no TLS of its own, so put it behind
something that provides both. Two good options:

- **A reverse proxy with automatic certificates.** With
  [Caddy](https://caddyserver.com) this is the whole config:

  ```
  keap.example.com {
      reverse_proxy 127.0.0.1:3000
  }
  ```

  With nginx, add `proxy_buffering off;` and a long `proxy_read_timeout` on the
  MCP location. Long reports stream progress events for tens of seconds, and
  buffering breaks that.

- **A private network, nothing public.** On a Tailscale or WireGuard host, set
  `KEAP_MCP_HOST` to the private address and connect over plain `http://`. The
  tunnel already encrypts traffic and only your own devices can reach it.

On each client machine:

```bash
claude mcp add --transport http keap https://keap.example.com/mcp \
  --scope user \
  --header "Authorization: Bearer <KEAP_MCP_AUTH_TOKEN>"
```

To roll this out to other people, send them [SETUP.md](SETUP.md). It has a
one-line installer (`scripts/install-client.sh`) that verifies the token and
configures both Claude Code and Claude Desktop, plus a prompt they can paste
into Claude to do the same by hand.

Clients that only launch stdio commands, such as Claude Desktop's config file,
can bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). The
header goes through an environment variable because Claude Desktop does not
escape spaces in arguments:

```json
{
  "mcpServers": {
    "keap": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://keap.example.com/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <KEAP_MCP_AUTH_TOKEN>" }
    }
  }
}
```

The claude.ai web app's custom connectors cannot send a custom header, so they
cannot use this setup. That would need OAuth, which is not implemented.

**Keeping it running.** `deploy/keapmcp.service` is a systemd unit for the
layout above (`/opt/keapmcp`, run as a `keapmcp` user). Or use the container:

```bash
docker build -t keapmcp .
docker run -d --name keapmcp --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -e KEAP_PAT=... -e KEAP_MCP_AUTH_TOKEN=... keapmcp
```

**Deploying on Coolify.** Coolify builds the Dockerfile straight from the
GitHub repo and puts its own TLS-terminating proxy in front, so none of the
proxy setup above is needed. Labels below are from Coolify v4.

1. In your project, choose **New Resource**, then **Public Repository** (or
   **Private Repository with GitHub App** for a private repo) and point it at
   `github.com/LiamHillier/keapmcp`, branch `main`.
2. Set **Build Pack** to **Dockerfile**. The Dockerfile is at the repo root.
3. Under **Network**, set **Ports Exposes** to `3000` and enter the domain you
   want, e.g. `https://keap.example.com`. Coolify issues the certificate.
4. Under **Environment Variables**, add `KEAP_PAT` and `KEAP_MCP_AUTH_TOKEN`.
   Leave "Build Variable" unticked; they are runtime settings. The image already
   sets `KEAP_MCP_HOST=0.0.0.0`.
5. **Deploy**. When it is up, `curl https://keap.example.com/healthz` returns
   `{"ok":true,...}` and the `claude mcp add` command above works with that
   domain.

Coolify's proxy streams responses without buffering, so progress notifications
work as they do locally. Container health in the Coolify UI comes from the
`HEALTHCHECK` in the Dockerfile. With the GitHub App source, enable
**Auto Deploy** to redeploy on every push to `main`.

**Checking it works.** `npm run smoke:http` starts the HTTP server on a spare
port and verifies authentication, tool listing, a live `keap_whoami`, and that
progress notifications stream through. From a client machine,
`curl https://keap.example.com/healthz` needs no token and confirms the proxy
path. After that, `claude mcp list` should show `keap` as connected.

**How it is built.** Each request gets a fresh transport and server instance
(the transport's stateless mode), so there is no session state to lose on a
restart and several replicas can sit behind one proxy. The Keap client is
shared across requests so its cache and rate limiter cover everyone: Keap's
10 QPS token limit applies to the server as a whole, not per client. It also
means everyone holding the secret acts as the same Keap user, so create the
PAT as a user who sees only what they should.

## Tools

| Tool | Purpose |
| --- | --- |
| `keap_whoami` | Verify the connection, show the account profile and endpoint coverage |
| `keap_find_endpoints` | Search all 228 read endpoints by keyword, area or version |
| `keap_describe_endpoint` | Parameters, pagination and result fields for one endpoint (optionally with a live sample) |
| `keap_get` | Call any read endpoint; auto-paginates, projects fields, filters client-side |
| `keap_aggregate` | Group and total records from any list endpoint — the workhorse for analytics |
| `keap_report` | Seven prebuilt reports that already know the right endpoints and fields |

Six tools rather than 228: exposing one tool per endpoint would swamp the model's
tool list and make it worse at picking the right one. Instead the full endpoint
catalogue is searchable data, and `keap_get`/`keap_aggregate` can reach every one
of them.

### Prebuilt reports

| Report | What it answers |
| --- | --- |
| `revenue` | Order revenue over time — count, revenue, average order value |
| `top_products` | Best-selling products by revenue and units (tax and fees excluded) |
| `top_customers` | Highest-spending contacts |
| `contact_growth` | New contacts per period |
| `pipeline` | Opportunities by stage, with probability-weighted value |
| `subscriptions` | Active subscriptions and estimated MRR/ARR |
| `tasks` | Task volume by owner and how many are overdue |

### Things you can ask

- "What was our revenue each month this year, and how does Q3 compare to Q2?"
- "Which products sold best since June?"
- "Who are our top 10 customers by spend?"
- "How many new contacts did we add each month?"
- "Break down opportunities by stage and owner."
- "How many contacts have the 'New Customer' tag?"
- "Which lead sources produced the most orders?"

The first four map onto `keap_report`. The rest go through `keap_find_endpoints`
→ `keap_aggregate`, which can group any list endpoint by any field.

## How it handles Keap's rough edges

These are the behaviours that make the difference between plausible numbers and
correct ones. Each was verified against a live account.

**Money encoding differs between versions.** v1 returns `total: 36.65`; v2
returns `total: {amount: 3665, currency_code: "AUD", formatted_amount: "$36.65"}`
— minor units. Values are normalised to major units, preferring
`formatted_amount` because it is already currency-aware (so zero-decimal
currencies like JPY are not divided by 100). Verified: v1 and v2 report the same
$150,710.97 for the same month.

**v1 accepts exactly one date format.** `2026-01-01` and `2026-01-01T00:00:00Z`
are both rejected with a 400; only `YYYY-MM-DDTHH:mm:ss.SSSZ` works. Date
parameters are converted automatically, and a bare `until` date is widened to the
end of that day so "until the 31st" includes the 31st.

**Product names are not in the product name field.** Orders created by storefront
integrations name every line item after its type — `"Product"`, `"Tax"`,
`"Special Category"` — and put the real product in `description`. Grouping on
`name` collapses the whole catalogue into one row called "Product". The reports
fall back to `description` (stripping SKU suffixes and HTML entities) and use
`item_type` to exclude tax and fee lines.

**Not every array is a collection.** `/account/profile` contains a
`business_goals` array but is a single record; `/orders` is a real list. The
catalogue classifies each endpoint using pagination markers and response shape,
so `keap_get` returns a record where there is one instead of a stray nested array.

**Pagination style decides how fast a report runs.** v1 pages by `limit`/`offset`
and reports a total `count`, so every page offset is known up front and all pages
are fetched concurrently — Keap serves parallel pages about 3x faster. v2 pages by
opaque token and is strictly sequential. Where both versions expose the same
fields the reports pick the v1 endpoint for this reason: the pipeline report over
20,000 opportunities takes ~33s instead of minutes, and revenue over 3,000 orders
dropped from 58s to 11s.

**Long calls report progress.** Reports that take tens of seconds emit MCP
progress notifications, so clients don't abandon them at their default timeout.

**v2 filters accept one condition only.** `filter=paid==true,order_type==ONLINE`
returns a 400. Pass a single server-side condition and do further narrowing with
the tools' own `filter` argument.

**Rate limits are respected.** Keap allows 10 requests/second, 240/minute and
30,000/day per token. Requests are paced at 8/s with bounded concurrency, plus
retry with backoff on 429 and 5xx, and a short response cache.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KEAP_PAT` | — | Personal Access Token or Service Account Key (required) |
| `KEAP_AUTH_MODE` | `apikey` | `apikey` sends `X-Keap-API-Key`, `bearer` sends `Authorization: Bearer`. Both work for PATs; `keap_whoami` reports which succeeded |
| `KEAP_MAX_QPS` | `8` | Request pacing ceiling |
| `KEAP_MAX_CONCURRENCY` | `6` | Simultaneous in-flight requests |
| `KEAP_PAGE_SIZE` | `500` | Records per page; smaller pages parallelise better |
| `KEAP_CACHE_TTL_MS` | `300000` | Response cache lifetime; set `0` to disable |
| `KEAP_MAX_PAGE_FETCH` | `20000` | Hard ceiling on records pulled in one tool call |
| `KEAP_TIMEOUT_MS` | `30000` | Per-request timeout |
| `KEAP_MCP_AUTH_TOKEN` | — | Hosted mode: shared secret clients send as `Authorization: Bearer`; `http.js` refuses to start without it |
| `KEAP_MCP_HOST` | `127.0.0.1` | Hosted mode: interface to listen on; `0.0.0.0` inside a container |
| `KEAP_MCP_PORT` | `3000` | Hosted mode: listen port |
| `KEAP_MCP_PATH` | `/mcp` | Hosted mode: URL path that serves MCP (`/healthz` is always available, unauthenticated) |

## Development

```bash
npm run catalog   # regenerate src/catalog.json from the OpenAPI specs
npm run build     # catalog + TypeScript compile
npm run smoke     # end-to-end test over stdio against the live account
npm run start:http   # hosted mode (see "Hosting it remotely")
npm run smoke:http   # end-to-end test of hosted mode: auth, tools, progress streaming
```

`src/catalog.json` is generated by `scripts/build-catalog.mjs` from Keap's own
OpenAPI 3.1 contracts in `spec/`. To pick up new Keap endpoints, replace those
files and re-run `npm run catalog`. The generator refuses to emit a catalogue with
fewer than 200 endpoints, so a malformed spec fails loudly instead of silently
shrinking the server's coverage.

### Layout

```
spec/                     Keap's OpenAPI v1 + v2 contracts (source of truth)
scripts/build-catalog.mjs Generates the endpoint catalogue
scripts/smoke.mjs         End-to-end test over stdio
scripts/smoke-http.mjs    End-to-end test over Streamable HTTP
scripts/install-client.sh Configures a colleague's Claude Code and Claude Desktop
src/config.ts             .env loading and settings
src/client.ts             HTTP: auth, pacing, retries, cache, pagination
src/catalog.ts            Endpoint index, search and resolution
src/analyze.ts            Filtering, grouping, metrics, money and date handling
src/reports.ts            The seven prebuilt reports
src/server.ts             Tool definitions; createServer() wires them to a client
src/index.ts              Stdio entrypoint (local clients)
src/http.ts               HTTP entrypoint with bearer auth (remote clients)
deploy/keapmcp.service    systemd unit for hosted mode
Dockerfile                Container image for hosted mode
```
