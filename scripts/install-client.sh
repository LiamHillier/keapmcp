#!/usr/bin/env bash
#
# Connect this machine's Claude Code and Claude Desktop to the hosted Keap MCP
# server. Safe to re-run: existing entries are replaced, not duplicated.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/LiamHillier/keapmcp/main/scripts/install-client.sh)
#
# Options:
#   --token <token>   Shared secret (or set KEAP_MCP_AUTH_TOKEN, or get prompted)
#   --url <url>       MCP endpoint (default: the Take Shape Adventures server)
#   --name <name>     Server name in the clients (default: keap)
#   --skip-code       Do not touch Claude Code
#   --skip-desktop    Do not touch Claude Desktop
#
# Supports macOS and Linux. Windows users: see SETUP.md for manual steps.

set -euo pipefail

URL="https://keapmcp.takeshapeadventures.com.au/mcp"
NAME="keap"
TOKEN="${KEAP_MCP_AUTH_TOKEN:-}"
DO_CODE=1
DO_DESKTOP=1
MCP_REMOTE_VERSION="0.8.4"

usage() {
  cat <<'HELP'
Connect this machine's Claude Code and Claude Desktop to the hosted Keap MCP
server. Safe to re-run: existing entries are replaced, not duplicated.

  bash <(curl -fsSL https://raw.githubusercontent.com/LiamHillier/keapmcp/main/scripts/install-client.sh)

Options:
  --token <token>   Shared secret (or set KEAP_MCP_AUTH_TOKEN, or get prompted)
  --url <url>       MCP endpoint (default: the Take Shape Adventures server)
  --name <name>     Server name in the clients (default: keap)
  --skip-code       Do not touch Claude Code
  --skip-desktop    Do not touch Claude Desktop

Supports macOS and Linux. Windows users: see SETUP.md for manual steps.
HELP
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --url) URL="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --skip-code) DO_CODE=0; shift ;;
    --skip-desktop) DO_DESKTOP=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required"

# --- Token ------------------------------------------------------------------

if [ -z "$TOKEN" ] && { exec 3<>/dev/tty; } 2>/dev/null; then
  printf 'Paste the Keap MCP access token (input hidden): ' >&3
  IFS= read -rs -u 3 TOKEN || true
  printf '\n' >&3
  exec 3>&-
fi
[ -n "$TOKEN" ] || die "No token given. Pass --token <token> or set KEAP_MCP_AUTH_TOKEN."
TOKEN="${TOKEN//[[:space:]]/}"

# --- Reachability and token check ------------------------------------------

BASE="${URL%/*}"
say "Checking $BASE/healthz"
curl -fsS --max-time 15 "$BASE/healthz" >/dev/null || die "Server not reachable at $BASE. Check your network and the URL."

say "Checking the token"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install-client","version":"1"}}}'
STATUS=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$INIT")
case "$STATUS" in
  200) say "Token accepted" ;;
  401) die "The server rejected this token (401). Check it was copied completely." ;;
  *)   die "Unexpected response $STATUS from $URL" ;;
esac

# --- Claude Code --------------------------------------------------------------

if [ "$DO_CODE" = 1 ]; then
  if command -v claude >/dev/null; then
    say "Configuring Claude Code (user scope, name: $NAME)"
    claude mcp remove "$NAME" -s user >/dev/null 2>&1 || true
    claude mcp add --transport http "$NAME" "$URL" --scope user \
      --header "Authorization: Bearer $TOKEN" >/dev/null
    if claude mcp get "$NAME" 2>/dev/null | grep -q "Connected"; then
      say "Claude Code: $NAME connected"
    else
      warn "Claude Code entry written, but 'claude mcp get $NAME' did not report Connected. Run it to see why."
    fi
  else
    warn "Claude Code ('claude' command) not found; skipping. Install it and re-run, or use Claude Desktop."
  fi
fi

# --- Claude Desktop -----------------------------------------------------------

if [ "$DO_DESKTOP" = 1 ]; then
  case "$(uname -s)" in
    Darwin)
      CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
      INSTALLED=0
      [ -d "/Applications/Claude.app" ] || [ -d "$HOME/Applications/Claude.app" ] && INSTALLED=1
      ;;
    Linux)
      CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json"
      INSTALLED=0
      [ -d "$(dirname "$CONFIG")" ] && INSTALLED=1
      ;;
    *)
      CONFIG=""; INSTALLED=0
      warn "Claude Desktop setup is only automated on macOS and Linux. See SETUP.md for Windows."
      ;;
  esac

  if [ "$INSTALLED" = 1 ]; then
    if ! command -v node >/dev/null; then
      warn "Claude Desktop is installed but Node.js is not. Install Node 22 from https://nodejs.org and re-run."
    elif ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
      warn "Claude Desktop needs Node 20 or newer for the bridge; found $(node -v). Upgrade Node and re-run."
    else
      NODE_BIN_DIR="$(cd "$(dirname "$(command -v node)")" && pwd)"
      NPX="$NODE_BIN_DIR/npx"
      [ -x "$NPX" ] || die "Expected npx next to node at $NPX"

      say "Configuring Claude Desktop ($CONFIG)"
      mkdir -p "$(dirname "$CONFIG")"
      if [ -f "$CONFIG" ]; then
        cp "$CONFIG" "$CONFIG.bak.$(date +%Y%m%d%H%M%S)"
      fi
      # Desktop launches servers without a login shell, so the entry pins the
      # absolute npx path and a PATH containing that Node's bin directory.
      CONFIG_PATH="$CONFIG" NAME="$NAME" URL="$URL" TOKEN="$TOKEN" NPX="$NPX" \
      NODE_BIN_DIR="$NODE_BIN_DIR" MCP_REMOTE_VERSION="$MCP_REMOTE_VERSION" \
      node -e '
        const fs = require("fs");
        const p = process.env.CONFIG_PATH;
        let cfg = {};
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, "utf8").trim();
          if (raw) cfg = JSON.parse(raw);
        }
        cfg.mcpServers = cfg.mcpServers || {};
        cfg.mcpServers[process.env.NAME] = {
          command: process.env.NPX,
          args: ["-y", "mcp-remote@" + process.env.MCP_REMOTE_VERSION, process.env.URL,
                 "--header", "Authorization:${AUTH_HEADER}"],
          env: {
            AUTH_HEADER: "Bearer " + process.env.TOKEN,
            PATH: process.env.NODE_BIN_DIR + ":/usr/local/bin:/usr/bin:/bin",
          },
        };
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
      '
      say "Claude Desktop: $NAME entry written. Quit Claude Desktop fully (Cmd+Q) and reopen it."
    fi
  elif [ -n "$CONFIG" ]; then
    say "Claude Desktop not found; skipping."
  fi
fi

say "Done. Ask Claude something like: \"What was our revenue by month this year?\""
