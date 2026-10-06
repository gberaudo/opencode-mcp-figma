import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SERVER_URL = "https://mcp.figma.com/mcp";
const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "mcp-auth.json");
const TEMP_AUTH_FILE = `${AUTH_FILE}.tmp`;

interface StoredEntry {
  serverUrl?: string;
  clientInfo?: {
    clientId?: string;
    clientSecret?: string;
    clientIdIssuedAt?: number;
    clientSecretExpiresAt?: number;
  };
  tokens?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scope?: string;
  };
}

function readEntries(): Record<string, StoredEntry> {
  if (!existsSync(AUTH_FILE)) throw new Error("OpenCode MCP auth file is missing.");
  return JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, StoredEntry>;
}

function saveEntries(entries: Record<string, StoredEntry>): void {
  writeFileSync(TEMP_AUTH_FILE, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(TEMP_AUTH_FILE, 0o600);
  renameSync(TEMP_AUTH_FILE, AUTH_FILE);
  chmodSync(AUTH_FILE, 0o600);
}

class StoredOAuthProvider {
  get redirectUrl(): string {
    return "http://127.0.0.1:3000/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Codex",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const info = readEntries().figma?.clientInfo;
    if (!info?.clientId) return undefined;
    return {
      client_id: info.clientId,
      ...(info.clientSecret !== undefined && { client_secret: info.clientSecret }),
      ...(info.clientIdIssuedAt !== undefined && { client_id_issued_at: info.clientIdIssuedAt }),
      ...(info.clientSecretExpiresAt !== undefined && { client_secret_expires_at: info.clientSecretExpiresAt }),
    };
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const tokens = readEntries().figma?.tokens;
    if (!tokens?.accessToken) return undefined;
    const now = Date.now() / 1000;
    return {
      access_token: tokens.accessToken,
      token_type: "bearer",
      ...(tokens.refreshToken !== undefined && { refresh_token: tokens.refreshToken }),
      ...(tokens.expiresAt !== undefined && { expires_in: Math.max(0, Math.round(tokens.expiresAt - now)) }),
      ...(tokens.scope !== undefined && { scope: tokens.scope }),
    };
  }

  saveTokens(tokens: OAuthTokens): void {
    const entries = readEntries();
    const entry = entries.figma ?? {};
    const now = Date.now() / 1000;
    entry.serverUrl = SERVER_URL;
    entry.tokens = {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token !== undefined && { refreshToken: tokens.refresh_token }),
      ...(tokens.expires_in !== undefined && { expiresAt: now + tokens.expires_in }),
      ...(tokens.scope !== undefined && { scope: tokens.scope }),
    };
    entries.figma = entry;
    saveEntries(entries);
  }

  async redirectToAuthorization(): Promise<void> {
    throw new Error("Figma authorization needs to be renewed; run the isolated OAuth helper again.");
  }

  saveCodeVerifier(): void {}
  codeVerifier(): string {
    throw new Error("Interactive Figma OAuth is not available from the stdio bridge.");
  }
}

async function main(): Promise<void> {
  const entry = readEntries().figma;
  if (entry?.serverUrl !== SERVER_URL || !entry.tokens?.accessToken || !entry.clientInfo?.clientId) {
    throw new Error("Figma credentials are missing or do not match the configured MCP endpoint.");
  }

  const client = new Client({ name: "OpenCode", version: "2.0.24" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
    authProvider: new StoredOAuthProvider(),
  });
  await client.connect(transport);

  const server = new Server(
    { name: "figma", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {}, completions: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (request) => client.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, (request) => client.callTool(request.params));
  server.setRequestHandler(ListResourcesRequestSchema, (request) => client.listResources(request.params));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => client.listResourceTemplates(request.params));
  server.setRequestHandler(ReadResourceRequestSchema, (request) => client.readResource(request.params));
  server.setRequestHandler(ListPromptsRequestSchema, (request) => client.listPrompts(request.params));
  server.setRequestHandler(GetPromptRequestSchema, (request) => client.getPrompt(request.params));
  server.setRequestHandler(CompleteRequestSchema, (request) => client.complete(request.params));
  server.setRequestHandler(SubscribeRequestSchema, (request) => client.subscribeResource(request.params));
  server.setRequestHandler(UnsubscribeRequestSchema, (request) => client.unsubscribeResource(request.params));

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  process.on("SIGINT", () => void Promise.all([client.close(), server.close()]));
  process.on("SIGTERM", () => void Promise.all([client.close(), server.close()]));
}

main().catch((error: unknown) => {
  console.error(`[figma-proxy] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
