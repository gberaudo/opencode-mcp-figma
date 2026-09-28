import { createServer, type Server } from "node:http";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { type McpOAuthConfig, McpOAuthProvider } from "./oauth-provider.js";
import { serverKey } from "./storage.js";
import { writeOpenCodeCredential } from "./opencode-store.js";

const CALLBACK_PORT = 3001;
const OAUTH_CALLBACK_PATH = "/callback";

async function startCallbackServer(provider: McpOAuthProvider): Promise<Server> {
  const app = express();

  app.get(OAUTH_CALLBACK_PATH, (req, res) => {
    const code = req.query.code as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) {
      res.status(400).send(`<h1>Authorization failed</h1><p>${error}</p>`);
      console.error(`[OAuth] Authorization error: ${error}`);
      return;
    }

    if (!code) {
      res.status(400).send("<h1>Missing authorization code</h1>");
      return;
    }

    res.send("<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>");

    provider.receiveAuthorizationCode(code);
  });

  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(CALLBACK_PORT, () => {
      console.log(`[OAuth] Callback server listening on http://localhost:${CALLBACK_PORT}`);
      resolve(server);
    });
  });
}

async function connectWithAuth(mcpServerUrl: string, provider: McpOAuthProvider): Promise<Client> {
  const url = new URL(mcpServerUrl);
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: provider,
  });

  const client = new Client({ name: "Codex", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    console.log("[MCP] Connected successfully.");
    return client;
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // The provider's redirectToAuthorization was already called.
      // Wait for the user to complete the browser flow.
      console.log("[OAuth] Waiting for authorization code via browser...");
      const code = await provider.waitForAuthorizationCode();

      console.log("[OAuth] Authorization code received. Finishing auth...");
      await transport.finishAuth(code);

      // Transport and client can only be started once; create fresh instances.
      console.log("[MCP] Retrying connection after authentication...");
      const retryTransport = new StreamableHTTPClientTransport(url, {
        authProvider: provider,
      });
      const retryClient = new Client({ name: "Codex", version: "1.0.0" }, { capabilities: {} });
      await retryClient.connect(retryTransport);
      console.log("[MCP] Connected successfully.");
      return retryClient;
    }
    throw err;
  }
}

function parseArgs(argv: string[]): {
  url: string | undefined;
  name: string | undefined;
  backup: boolean;
  skipOpencode: boolean;
} {
  const positional: string[] = [];
  const flags: { name?: string; backup?: boolean; skipOpencode?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") flags.name = argv[++i];
    else if (arg === "--backup") flags.backup = true;
    else if (arg === "--skip-opencode") flags.skipOpencode = true;
    else positional.push(arg);
  }
  return { url: positional[0], name: flags.name, backup: flags.backup === true, skipOpencode: flags.skipOpencode === true };
}

async function main() {
  const { url: mcpServerUrl, name: nameFlag, backup, skipOpencode } = parseArgs(process.argv.slice(2));
  if (!mcpServerUrl) {
    console.error("Usage: npm start -- <mcp-server-url> [--name <opencode-server-name>] [--backup] [--skip-opencode]");
    console.error("  Example: npm start -- https://mcp.figma.com/mcp");
    console.error("");
    console.error("  --name           Server name in opencode.json (mcp.servers.<name>).");
    console.error("                   Defaults to the URL hostname SLD, e.g. \"figma\".");
    console.error("  --backup         Snapshot ~/.local/share/opencode/opencode.db before writing.");
    console.error("  --skip-opencode  Only write mcp-auth.json (legacy V1 behavior).");
    process.exit(1);
  }

  // OpenCode V2 keys the credential by (server name, url) — the name here must
  // match `mcp.servers.<name>` in opencode.json.
  const opencodeServerName = nameFlag ?? serverKey(mcpServerUrl);

  const config: McpOAuthConfig = {
    serverUrl: mcpServerUrl,
    callbackPort: CALLBACK_PORT,
  };

  const provider = new McpOAuthProvider(config);

  // Start the local HTTP server to receive the OAuth callback
  const callbackServer = await startCallbackServer(provider);

  let client: Client | undefined;
  try {
    client = await connectWithAuth(mcpServerUrl, provider);

    // List available tools as a smoke-test
    console.log("\n[MCP] Listing available tools...");
    const tools = await client.listTools();
    if (tools.tools.length === 0) {
      console.log("[MCP] No tools available on this server.");
    } else {
      console.log("[MCP] Available tools:");
      for (const tool of tools.tools) {
        console.log(`  - ${tool.name}: ${tool.description ?? "(no description)"}`);
      }
    }

    if (!skipOpencode) {
      const snapshot = provider.authSnapshot();
      if (!snapshot.tokens) {
        console.warn("[OpenCode V2] No tokens stored; skipping credential write.");
      } else {
        console.log(`\n[OpenCode V2] Writing credential for server "${opencodeServerName}"...`);
        writeOpenCodeCredential(
          {
            serverName: opencodeServerName,
            serverUrl: snapshot.serverUrl,
            tokens: snapshot.tokens,
            client: snapshot.client,
          },
          { backup },
        );
      }
    }
  } finally {
    if (client) {
      await client.close();
      console.log("[MCP] Connection closed.");
    }
    callbackServer.close(() => {
      console.log("[OAuth] Callback server stopped.");
    });
  }
}

main().catch((err) => {
  console.error("[Error]", err);
  process.exit(1);
});
