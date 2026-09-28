import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Writes OAuth results into OpenCode V2's global credential store so the
 * authenticated MCP server is usable without any manual file merging.
 *
 * Target shape verified against opencode v2.0.18 sources:
 * - packages/core/src/mcp/index.ts   integrationID = "mcp_" + sha1(name + "\\0" + url)[:16]
 *                                    (identity is name + url: same URL under two
 *                                     server names must not share a credential)
 * - packages/core/src/mcp/oauth.ts   connectProvider picks credentials.list(integrationID).at(-1)
 *                                    and reads Credential.OAuth + metadata.client
 * - packages/schema/src/credential.ts OAuth = { type:"oauth", methodID, access, refresh,
 *                                    expires(ms, 0 = non-expiring), metadata }
 * - core/dist (zod, RFC 7591)        client info must be snake_case; unknown keys are
 *                                    stripped, so camelCase V1 keys would be silently
 *                                    dropped and the client treated as unregistered
 * - packages/core/src/credential.ts  list() orders by asc(active), asc(time_created), asc(id)
 *                                    -> active = 1 makes the row win .at(-1)
 */

export interface OpenCodeCredentialInput {
  /** Server name as configured in opencode.json (`mcp.servers.<name>`). */
  readonly serverName: string;
  readonly serverUrl: string;
  readonly tokens: OAuthTokens;
  readonly client: OAuthClientInformationMixed | undefined;
}

export interface OpenCodeStoreOptions {
  /** Override the DB path (defaults to ~/.local/share/opencode/opencode.db). */
  readonly dbPath?: string;
  /** Snapshot the database with `VACUUM INTO` before writing. */
  readonly backup?: boolean;
}

export function integrationID(serverName: string, serverUrl: string): string {
  const digest = createHash("sha1").update(`${serverName}\u0000${serverUrl}`).digest("hex");
  return `mcp_${digest.slice(0, 16)}`;
}

function defaultDbPath(): string {
  return process.env.OPENCODE_DB ?? path.join(homedir(), ".local/share/opencode/opencode.db");
}

/** camelCase-free client subset the SDK's StoredOAuthClientInformation expects. */
function storedClient(client: OAuthClientInformationMixed | undefined) {
  if (!client) return undefined;
  const out: Record<string, unknown> = { client_id: client.client_id };
  if (client.client_secret !== undefined) out.client_secret = client.client_secret;
  if (client.client_id_issued_at !== undefined) out.client_id_issued_at = client.client_id_issued_at;
  if (client.client_secret_expires_at !== undefined) out.client_secret_expires_at = client.client_secret_expires_at;
  return out;
}

export function writeOpenCodeCredential(input: OpenCodeCredentialInput, options: OpenCodeStoreOptions = {}): void {
  const dbPath = options.dbPath ?? defaultDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  try {
    if (options.backup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${dbPath}.pre-cred-${stamp}.bak`;
      db.exec(`VACUUM INTO '${backupPath}'`);
      console.log(`[OpenCode V2] Database backed up to ${backupPath}`);
    }

    const id = integrationID(input.serverName, input.serverUrl);
    const now = Date.now();
    const expires = input.tokens.expires_in !== undefined ? now + input.tokens.expires_in * 1000 : 0;
    const value = {
      type: "oauth",
      methodID: id,
      access: input.tokens.access_token,
      refresh: input.tokens.refresh_token ?? "",
      expires,
      metadata: {
        serverUrl: input.serverUrl,
        tokenType: input.tokens.token_type ?? "Bearer",
        ...(input.tokens.scope ? { scope: input.tokens.scope } : {}),
        ...(storedClient(input.client) ? { client: storedClient(input.client) } : {}),
      },
    };

    const existing = db.prepare("SELECT id FROM credential WHERE integration_id = ?").get(id);
    if (existing) {
      db.prepare("UPDATE credential SET value = ?, active = 1, time_updated = ? WHERE id = ?").run(
        JSON.stringify(value),
        now,
        (existing as { id: string }).id,
      );
      console.log(`[OpenCode V2] Credential updated for "${input.serverName}" (${id})`);
    } else {
      const credID = `cred_${now}${Math.random().toString(36).slice(2, 12)}`;
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated)" +
          " VALUES (?, ?, ?, ?, NULL, NULL, 1, ?, ?)",
      ).run(credID, id, input.serverName, JSON.stringify(value), now, now);
      console.log(`[OpenCode V2] Credential inserted for "${input.serverName}" (${id})`);
    }

    const checked = db.prepare("SELECT active FROM credential WHERE integration_id = ?").get(id);
    if (!checked || (checked as { active: number }).active !== 1) {
      throw new Error("credential row is not active after write");
    }
    console.log(
      `[OpenCode V2] Done. Restart OpenCode (or run \`opencode service restart\`) and the server should show "connected".`,
    );
  } finally {
    db.close();
  }
}
