# Log into figma MCP

## What is it for?

Figma MCP rejects non-whitelisted agents, including OpenCode.
This almost no-dependency code allows to authenticate and write the result straight into OpenCode's credential store.

For context and alternatives, see https://github.com/anomalyco/opencode/issues/988

## How it works

1. Runs the full OAuth flow against the MCP server in a browser (client name `Codex`),
   collecting tokens **and** the dynamically registered client information.
2. Writes the result into OpenCode V2's global credential store:
   `~/.local/share/opencode/opencode.db`, table `credential`.
3. Also keeps writing the legacy `mcp-auth.json` (V1 format) next to the project for
   inspection / manual merge into a V1 installation.

OpenCode V2 (>= 2.0) never reads `mcp-auth.json`; the DB row is what makes the server show
`connected` after a restart.

## Authenticating

```bash
npm i
npm run build
npm start -- https://mcp.figma.com/mcp
```

Then restart OpenCode (`opencode service restart`) and check `opencode mcp list` — the
server should show `connected`.

### Flags

| Flag | Meaning |
| --- | --- |
| `--name <name>` | Server name in `opencode.json` (`mcp.servers.<name>`). Defaults to the URL hostname SLD, e.g. `figma`. **The credential is keyed by (name, url)** — the name must match your OpenCode config. |
| `--backup` | Snapshot the whole DB with `VACUUM INTO` before writing (the DB can be large). |
| `--skip-opencode` | Legacy behavior: only write `mcp-auth.json`, do not touch OpenCode. |

`OPENCODE_DB` environment variable overrides the target database path.

## Credential row shape (opencode v2.0.18)

The row is written to match what OpenCode V2 reads at connect time:

- `integration_id` / `value.methodID`: `"mcp_" + sha1(name + "\\0" + url)[:16]`
  (see `packages/core/src/mcp/index.ts`; identity is **name + url**, so the same URL
  under two server names does not share credentials)
- `value`: `{ "type": "oauth", "methodID", "access", "refresh", "expires", "metadata" }`
  (see `packages/schema/src/credential.ts`); `expires` is **milliseconds** since epoch,
  `0` means non-expiring
- `value.metadata.client`: RFC 7591 **snake_case** — `client_id`, `client_secret`,
  `client_id_issued_at`, `client_secret_expires_at`. The SDK's zod schema strips unknown
  keys, so V1's camelCase (`clientId`, …) would be silently dropped and the client
  treated as unregistered.
- `value.metadata.serverUrl` / `tokenType`: echoed back by OpenCode when refreshing
- `active`: `1` — `connectProvider` takes the last of `list(integrationID)`, which orders
  inactive rows first, so the active row wins

Token refreshes are handled by OpenCode itself afterwards and written back to the same row
(`saveTokens` -> `credentials.update`).

## Add to MCP (legacy, V1)

Only needed for OpenCode V1: move or merge the produced `mcp-auth.json` into
`~/.local/share/opencode/mcp-auth.json` (camelCase there). V1's schema
(`packages/opencode/src/mcp/auth.ts`) stores `clientId`/`clientSecret`/`tokens.expiresAt`
(seconds) under a key derived from the URL hostname.

## Other MCPs?

This was only tested with Figma. Any remote MCP server that accepts the `Codex` client
should work the same way; pass the matching `--name` when its `mcp.servers` entry differs
from the hostname SLD.
