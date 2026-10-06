import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const AUTH_FILE = "mcp-auth.json";

/** Shape as stored in mcp-auth.json (camelCase, matching the file format). */
export interface StoredClientInfo {
  clientId?: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
}

/** Tokens as stored in mcp-auth.json (camelCase keys, expiresAt as absolute timestamp). */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Absolute Unix timestamp (seconds) when the access token expires. */
  expiresAt?: number;
}

export interface ServerAuthEntry {
  clientInfo?: StoredClientInfo;
  serverUrl?: string;
  tokens?: StoredTokens;
}

export interface ServerStateEntry {
  oauthState?: string;
  codeVerifier?: string;
}

type AuthFileContents = Record<string, ServerAuthEntry | ServerStateEntry>;

function readFile(): AuthFileContents {
  if (!existsSync(AUTH_FILE)) return {};
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as AuthFileContents;
  } catch {
    return {};
  }
}

function writeFile(contents: AuthFileContents): void {
  writeFileSync(AUTH_FILE, `${JSON.stringify(contents, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(AUTH_FILE, 0o600);
}

/**
 * Derives a stable lowercase key from a server URL hostname.
 * e.g. "https://mcp.figma.com/mcp" -> "figma"
 */
export function serverKey(serverUrl: string): string {
  try {
    const host = new URL(serverUrl).hostname; // e.g. "mcp.figma.com"
    const parts = host.replace(/^www\./, "").split(".");
    // Second-to-last part is the SLD, e.g. "figma" from "mcp.figma.com"
    return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  } catch {
    return serverUrl;
  }
}

/**
 * Title-case version of the key, used for the state entry in mcp-auth.json.
 */
function stateKey(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export class AuthStorage {
  private readonly key: string;
  private readonly sKey: string;
  private readonly serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
    this.key = serverKey(serverUrl);
    this.sKey = stateKey(this.key);
  }

  loadClientInformation(): OAuthClientInformationMixed | undefined {
    const data = readFile();
    const info = (data[this.key] as ServerAuthEntry | undefined)?.clientInfo;
    if (!info?.clientId) return undefined;
    return {
      client_id: info.clientId,
      ...(info.clientSecret !== undefined && { client_secret: info.clientSecret }),
      ...(info.clientIdIssuedAt !== undefined && { client_id_issued_at: info.clientIdIssuedAt }),
      ...(info.clientSecretExpiresAt !== undefined && { client_secret_expires_at: info.clientSecretExpiresAt }),
    };
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    const data = readFile();
    const entry = (data[this.key] as ServerAuthEntry) ?? {};
    entry.serverUrl = this.serverUrl;
    entry.clientInfo = {
      clientId: info.client_id,
      ...("client_secret" in info && info.client_secret !== undefined && { clientSecret: info.client_secret }),
      ...("client_id_issued_at" in info &&
        info.client_id_issued_at !== undefined && { clientIdIssuedAt: info.client_id_issued_at }),
      ...("client_secret_expires_at" in info &&
        info.client_secret_expires_at !== undefined && { clientSecretExpiresAt: info.client_secret_expires_at }),
    };
    data[this.key] = entry;
    writeFile(data);
  }

  loadTokens(): OAuthTokens | undefined {
    const data = readFile();
    const stored = (data[this.key] as ServerAuthEntry | undefined)?.tokens;
    if (!stored) return undefined;
    const now = Date.now() / 1000;
    return {
      access_token: stored.accessToken,
      token_type: "bearer",
      ...(stored.refreshToken !== undefined && { refresh_token: stored.refreshToken }),
      ...(stored.expiresAt !== undefined && { expires_in: Math.max(0, Math.round(stored.expiresAt - now)) }),
    };
  }

  saveTokens(tokens: OAuthTokens): void {
    const data = readFile();
    const entry = (data[this.key] as ServerAuthEntry) ?? {};
    entry.serverUrl = this.serverUrl;
    const now = Date.now() / 1000;
    const stored: StoredTokens = {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token !== undefined && { refreshToken: tokens.refresh_token }),
      ...(tokens.expires_in !== undefined && { expiresAt: now + tokens.expires_in }),
    };
    entry.tokens = stored;
    data[this.key] = entry;
    writeFile(data);
  }

  loadCodeVerifier(): string | undefined {
    const data = readFile();
    return (data[this.sKey] as ServerStateEntry | undefined)?.codeVerifier;
  }

  saveCodeVerifier(codeVerifier: string): void {
    const data = readFile();
    const entry = (data[this.sKey] as ServerStateEntry) ?? {};
    entry.codeVerifier = codeVerifier;
    data[this.sKey] = entry;
    writeFile(data);
  }

  loadOAuthState(): string | undefined {
    const data = readFile();
    return (data[this.sKey] as ServerStateEntry | undefined)?.oauthState;
  }

  saveOAuthState(state: string): void {
    const data = readFile();
    const entry = (data[this.sKey] as ServerStateEntry) ?? {};
    entry.oauthState = state;
    data[this.sKey] = entry;
    writeFile(data);
  }

  clearOAuthState(): void {
    const data = readFile();
    const entry = data[this.sKey] as ServerStateEntry | undefined;
    if (!entry) return;
    delete entry.oauthState;
    if (!entry.codeVerifier) delete data[this.sKey];
    else data[this.sKey] = entry;
    writeFile(data);
  }
}
