# Figma MCP bridge for OpenCode

This project contains two small programs that let OpenCode connect to Figma's remote MCP server:

- `src/index.ts` runs the one-time OAuth authorization flow and writes an OpenCode-compatible `mcp-auth.json` entry.
- `src/stdio-proxy.ts` exposes Figma's remote MCP over local stdio, forwarding tools, resources, prompts, completions, and resource subscriptions to `https://mcp.figma.com/mcp`.

The stdio bridge is used because OpenCode's direct OAuth flow was not accepted by Figma in this setup. The authorization helper registers the OAuth client with the name **Codex**. This is a compatibility workaround, not an official OpenCode integration or an OpenCode OAuth registration. Figma can change or block this behavior. Use it only if it is permitted by your organization's policies and Figma's terms.

## Requirements

- Node.js 20 or newer (tested with Node 22)
- OpenCode 2.x
- A Figma account with access to the target file and the required seat/permissions for the requested operations
- A browser available for the one-time OAuth consent flow

Figma controls access by account, seat, file permissions, and plan. The presence of a tool such as `use_figma` does not guarantee that a particular account can write to every file.

## Build

Run from the repository root:

```bash
npm ci --ignore-scripts
npm run build
npm audit --omit=dev
```

The compiled programs are written under `dist/`. The repository ignores `dist/` and `node_modules/`; build them locally rather than committing them.

## Authorize Figma

Run the helper from a private working directory so its temporary `mcp-auth.json` is not created in the repository:

```bash
mkdir -m 700 -p "$HOME/.local/share/opencode/figma-oauth"
cd "$HOME/.local/share/opencode/figma-oauth"
node /path/to/opencode-mcp-figma/dist/index.js https://mcp.figma.com/mcp
```

The helper opens the Figma consent page and listens for the OAuth callback on `127.0.0.1:3000`. Review the consent in the browser. The resulting `mcp-auth.json` contains secrets; keep its permissions private and never commit or share it.

### Merge the Figma credential into OpenCode

OpenCode stores MCP OAuth entries in `~/.local/share/opencode/mcp-auth.json`. Merge only the `figma` entry from the helper output, preserving any other MCP entries already in that file. Back up an existing file first. Do not replace the whole file if you have credentials for other MCP servers.

The helper creates its file with mode `0600`. Keep the destination at mode `0600` as well:

```bash
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(process.cwd(), 'mcp-auth.json');
const target = path.join(process.env.HOME, '.local/share/opencode/mcp-auth.json');
const incoming = JSON.parse(fs.readFileSync(source, 'utf8')).figma;
if (!incoming?.tokens?.accessToken || !incoming?.clientInfo?.clientId || incoming.serverUrl !== 'https://mcp.figma.com/mcp') {
  throw new Error('The helper file has no complete Figma credential entry.');
}

fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
const entries = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
if (entries.figma?.serverUrl && entries.figma.serverUrl !== incoming.serverUrl) {
  throw new Error('An existing Figma entry points to another server; refusing to overwrite it.');
}
entries.figma = incoming;
const temporary = `${target}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
fs.chmodSync(temporary, 0o600);
fs.renameSync(temporary, target);
fs.chmodSync(target, 0o600);
console.log('Merged the Figma credential; other MCP entries were preserved.');
NODE
```

## Configure OpenCode

Add a global local MCP server entry to `~/.config/opencode/opencode.jsonc`, preserving your other settings and servers:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "figma": {
        "type": "local",
        "command": [
          "node",
          "/path/to/opencode-mcp-figma/dist/stdio-proxy.js"
        ]
      }
    }
  }
}
```

Replace the example path with the absolute path to this repository. Reload OpenCode and check the connection:

```bash
opencode reload
opencode mcp list
```

A connected server should expose the tools available to the authenticated Figma account. The bridge refreshes tokens when possible and saves refreshed credentials back to OpenCode's auth store. If interactive authorization is needed again, rerun the helper and repeat the merge.

## Security and limitations

- Never commit `mcp-auth.json`, OAuth tokens, client secrets, or browser callback URLs. `.gitignore` excludes `mcp-auth.json`, `node_modules/`, and `dist/`.
- The OAuth client is registered as `Codex` to pass Figma's current client allowlist. It is not an officially registered OpenCode client; that allowlist or Figma behavior may change.
- The helper and bridge are intended for personal/local use. Review them and your organization's security policy before using them with work accounts.
- Figma write operations still depend on the user's plan/seat and edit permission on the target file. A successful MCP connection alone does not imply write permission.

## Development notes

The OAuth callback binds to loopback, validates OAuth `state`, and writes credentials with restricted permissions. The local stdio bridge reads the Figma entry from OpenCode's auth store and proxies MCP requests to Figma; it does not include or print token values.

For background on OpenCode's OAuth support and the original workaround, see [OpenCode issue #988](https://github.com/anomalyco/opencode/issues/988).
