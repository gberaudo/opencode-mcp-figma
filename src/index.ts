import { createServer, type Server } from "node:http";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { type McpOAuthConfig, McpOAuthProvider } from "./oauth-provider.js";

const CALLBACK_PORT = 3000;
const OAUTH_CALLBACK_PATH = "/callback";

async function startCallbackServer(provider: McpOAuthProvider): Promise<Server> {
  const app = express();

  app.get(OAUTH_CALLBACK_PATH, (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const error = typeof req.query.error === "string" ? req.query.error : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;

    if (!provider.consumeState(state)) {
      res.status(400).send("<h1>Authorization failed</h1><p>Invalid OAuth state.</p>");
      console.error("[OAuth] Rejected callback with invalid state.");
      return;
    }

    if (error) {
      res.status(400).send("<h1>Authorization failed</h1><p>Figma declined authorization.</p>");
      console.error("[OAuth] Authorization was declined by Figma.");
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
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
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

async function main() {
  const mcpServerUrl = process.argv[2];
  if (!mcpServerUrl) {
    console.error("Usage: ts-node src/index.ts <mcp-server-url>");
    console.error("  Example: ts-node src/index.ts https://example.com/mcp");
    process.exit(1);
  }

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
