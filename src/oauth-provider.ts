import { spawnSync } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthStorage } from "./storage.js";

const OAUTH_CALLBACK_PATH = "/callback";

export interface McpOAuthConfig {
  clientId?: string;
  serverUrl: string;
  callbackPort?: number;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly config: McpOAuthConfig;
  private readonly port: number;
  private readonly storage: AuthStorage;

  // Resolve function called when the authorization code arrives via the callback
  private authCodeResolve?: (code: string) => void;

  constructor(config: McpOAuthConfig) {
    this.config = config;
    this.port = config.callbackPort ?? 3001;
    this.storage = new AuthStorage(config.serverUrl);
  }

  get redirectUrl(): string {
    return `http://localhost:${this.port}${OAUTH_CALLBACK_PATH}`;
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
    if (this.config.clientId) {
      return { client_id: this.config.clientId };
    }
    return this.storage.loadClientInformation();
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.storage.saveClientInformation(info);
    console.log(`[OAuth] Client registered: ${info.client_id}`);
  }

  tokens(): OAuthTokens | undefined {
    return this.storage.loadTokens();
  }

  saveTokens(tokens: OAuthTokens): void {
    this.storage.saveTokens(tokens);
    console.log("[OAuth] Tokens saved.");
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const url = authorizationUrl.toString();
    console.log(`\n[OAuth] Opening authorization URL in your browser:\n  ${url}\n`);
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawnSync(opener, [url], { stdio: "ignore" });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.storage.saveCodeVerifier(codeVerifier);
  }

  /** Everything an external credential store needs, post-authentication. */
  authSnapshot(): {
    serverUrl: string;
    client: OAuthClientInformationMixed | undefined;
    tokens: OAuthTokens | undefined;
  } {
    return {
      serverUrl: this.config.serverUrl,
      client: this.storage.loadClientInformation(),
      tokens: this.storage.loadTokens(),
    };
  }

  codeVerifier(): string {
    const v = this.storage.loadCodeVerifier();
    if (!v) throw new Error("[OAuth] No code verifier saved.");
    return v;
  }

  /**
   * Returns a Promise that resolves with the authorization code when the
   * OAuth callback is received. Call this before starting the auth flow.
   */
  waitForAuthorizationCode(): Promise<string> {
    return new Promise((resolve) => {
      this.authCodeResolve = resolve;
    });
  }

  /**
   * Called by the Express callback route with the authorization code.
   */
  receiveAuthorizationCode(code: string): void {
    if (this.authCodeResolve) {
      this.authCodeResolve(code);
      this.authCodeResolve = undefined;
    }
  }
}
