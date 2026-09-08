# Connecting to the Keap MCP server

This gives your Claude (Claude Code and Claude Desktop) read-only access to the
Take Shape Adventures Keap CRM, so you can ask questions like "what was revenue
by month this year?" or "who are our top customers since June?" in plain
language.

You need the **access token**. Ask whoever runs the server for it and keep it somewhere private,
such as your password manager. Never paste it into a shared channel.

## Option 1: run the install script (macOS and Linux)

Open Terminal and run:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/LiamHillier/keapmcp/main/scripts/install-client.sh)
```

It prompts for the token, checks it against the server, then configures Claude
Code (if the `claude` command is installed) and Claude Desktop (if the app is
installed). It is safe to run again later; existing entries are replaced.

When it finishes, quit Claude Desktop completely (Cmd+Q) and reopen it. In
Claude Code, `claude mcp list` should show `keap` as connected.

If it says Node.js is missing or too old, install Node 22 from
<https://nodejs.org> and run the script again. Claude Desktop needs Node to
reach the hosted server; Claude Code does not.

## Option 2: ask Claude to do it

If you already have Claude Code, or you are on Windows, paste this into Claude
Code with your token filled in:

```
I need the Keap MCP server set up on this computer. It is a hosted MCP server at
https://keapmcp.takeshapeadventures.com.au/mcp that uses bearer-token auth.
The token is: PASTE_TOKEN_HERE

Please:
1. Verify the token first. POST to that URL with headers
   "Authorization: Bearer <token>", "content-type: application/json" and
   "accept: application/json, text/event-stream", and this body:
   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"setup","version":"1"}}}
   Expect HTTP 200. If you get 401 the token is wrong: stop and tell me.
2. If the `claude` command exists, run:
   claude mcp add --transport http keap https://keapmcp.takeshapeadventures.com.au/mcp --scope user --header "Authorization: Bearer <token>"
   and confirm with `claude mcp get keap`.
3. If Claude Desktop is installed, add a "keap" entry under "mcpServers" in its
   config file, keeping everything else in that file intact. The file is
   ~/Library/Application Support/Claude/claude_desktop_config.json on macOS and
   %APPDATA%\Claude\claude_desktop_config.json on Windows. The entry is:
   {"command": "<absolute path to npx from a Node 20+ install>",
    "args": ["-y", "mcp-remote@0.8.4", "https://keapmcp.takeshapeadventures.com.au/mcp", "--header", "Authorization:${AUTH_HEADER}"],
    "env": {"AUTH_HEADER": "Bearer <token>"}}
   Leave the text ${AUTH_HEADER} exactly as written; the bridge expands it.
   On macOS also add "PATH" to "env", set to that Node's bin directory followed
   by :/usr/local/bin:/usr/bin:/bin, because Desktop does not load my shell
   profile. If Node is missing or older than 20, tell me how to install it
   instead of guessing a path.
4. Tell me to quit and reopen Claude Desktop. Do not print the token back to me.
```

## Option 3: by hand

**Claude Code**

```bash
claude mcp add --transport http keap https://keapmcp.takeshapeadventures.com.au/mcp \
  --scope user \
  --header "Authorization: Bearer PASTE_TOKEN_HERE"
```

**Claude Desktop** needs Node 20 or newer installed. Open the app's settings,
go to Developer, choose Edit Config, and add this inside `"mcpServers"`:

```json
"keap": {
  "command": "npx",
  "args": [
    "-y", "mcp-remote@0.8.4",
    "https://keapmcp.takeshapeadventures.com.au/mcp",
    "--header", "Authorization:${AUTH_HEADER}"
  ],
  "env": { "AUTH_HEADER": "Bearer PASTE_TOKEN_HERE" }
}
```

On macOS replace `"npx"` with its full path (run `which npx` in Terminal) and
add `"PATH"` to `"env"` with that folder first, for example
`"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`. The app does not see your
shell's PATH. On Windows, if `"npx"` alone fails, use the full path to
`npx.cmd`, usually `C:\\Program Files\\nodejs\\npx.cmd`.

Then quit Claude Desktop completely and reopen it.

## Checking it works

Ask Claude: *"Check the Keap connection"*. It should call `keap_whoami` and
report the Take Shape Adventures account. Then try a real question, such as
*"What was our revenue each month this year?"*

## If something goes wrong

- **"Token rejected" or 401 errors.** The token was mistyped or has been
  rotated. Get the current one and run the setup again.
- **Claude Desktop shows no Keap tools.** Make sure you quit the app fully
  rather than closing the window, and that Node 20+ is installed. The app's
  Developer settings show server logs.
- **Long reports time out.** Reports over large date ranges can take 10 to 30
  seconds while the server pages through Keap. Narrow the date range or ask
  again; results are cached for a few minutes.
- **Everyone shares one Keap identity.** The server acts as a single Keap user
  for all of us, so what you can see is what that user can see, regardless of
  your own Keap login.
