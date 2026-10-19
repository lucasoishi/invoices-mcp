/**
 * Minimal Google OAuth for a desktop app: loopback redirect + PKCE, read-only scopes (Gmail and/or Drive).
 * No third-party OAuth library, so the whole flow is auditable in this file.
 *
 * This is the ONLY place (together with api.ts and sync.ts) allowed to touch the network
 * or write to disk; test/privacy.test.ts enforces that.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { UserFacingError } from "../errors.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GoogleError extends UserFacingError {}
export class GoogleAuthError extends GoogleError {}
export class GoogleApiError extends GoogleError {}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface StoredToken {
  refreshToken: string;
  scope: string;
  savedAt: string;
}

export const defaultTokenPath = (): string => path.join(os.homedir(), ".invoices-mcp", "google-token.json");

/** Reads the credentials file downloaded from Google Cloud Console ("Desktop app" client). */
export async function loadClientConfig(file: string): Promise<OAuthClientConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new GoogleAuthError("The Google credentials file could not be read as JSON.");
  }
  const section = (raw as { installed?: Record<string, unknown>; web?: Record<string, unknown> }).installed ??
    (raw as { web?: Record<string, unknown> }).web;
  const clientId = section?.["client_id"];
  const clientSecret = section?.["client_secret"];
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new GoogleAuthError('The credentials file has no client_id/client_secret. Download an OAuth client of type "Desktop app".');
  }
  // A tampered file must not be able to send the client secret or tokens to another host.
  const tokenUri = section?.["token_uri"];
  if (tokenUri !== undefined && tokenUri !== TOKEN_URL) {
    throw new GoogleAuthError(`Unexpected token_uri in the credentials file (expected ${TOKEN_URL}).`);
  }
  return { clientId, clientSecret };
}

export async function loadToken(file: string): Promise<StoredToken | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<StoredToken>;
    return typeof parsed.refreshToken === "string" && parsed.refreshToken
      ? { refreshToken: parsed.refreshToken, scope: parsed.scope ?? "", savedAt: parsed.savedAt ?? "" }
      : null;
  } catch {
    return null;
  }
}

export async function saveToken(file: string, token: StoredToken): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // 0600 is honoured on macOS/Linux; on Windows the file inherits your profile's ACL.
  await fs.writeFile(file, JSON.stringify(token, null, 2), { mode: 0o600 });
}

const base64url = (buf: Buffer): string => buf.toString("base64url");

export interface AuthFlowOptions {
  client: OAuthClientConfig;
  tokenPath: string;
  /** Called with the URL the user must open. Defaults to printing it on stderr. */
  onAuthUrl?: (url: string) => void;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Read-only scopes to request. Defaults to Gmail. */
  scopes?: string[];
}

/** Interactive one-time authorisation. Stores a refresh token; never stores the access token. */
export async function runAuthFlow(opts: AuthFlowOptions): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const scopes = opts.scopes && opts.scopes.length > 0 ? opts.scopes : [GMAIL_SCOPE];
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = http.createServer();
    const timer = setTimeout(() => {
      server.close();
      reject(new GoogleAuthError("Timed out waiting for the browser sign-in (5 minutes)."));
    }, opts.timeoutMs ?? 300_000);

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const gotCode = url.searchParams.get("code");
      const finish = (status: number, message: string) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
        clearTimeout(timer);
        server.close();
      };
      if (error) {
        finish(400, "Authorisation was cancelled. You can close this tab.");
        reject(new GoogleAuthError(`Google reported an error: ${error}`));
      } else if (!gotCode || url.searchParams.get("state") !== state) {
        finish(400, "Invalid response. You can close this tab.");
        reject(new GoogleAuthError("The sign-in response did not match this request (state mismatch)."));
      } else {
        finish(200, "Authorised. You can close this tab and return to the terminal.");
        resolve({ code: gotCode, redirectUri });
      }
    });

    let redirectUri = "";
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      redirectUri = `http://127.0.0.1:${port}`;
      const params = new URLSearchParams({
        client_id: opts.client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        access_type: "offline",
        prompt: "consent",
      });
      const authUrl = `${AUTH_URL}?${params.toString()}`;
      (opts.onAuthUrl ?? ((u) => process.stderr.write(`Open this URL in your browser to authorise read-only Google access:\n\n${u}\n\n`)))(
        authUrl,
      );
    });
  });

  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new GoogleAuthError(`Google rejected the authorisation code (HTTP ${response.status}).`);
  const body = (await response.json()) as { refresh_token?: string; scope?: string };
  if (!body.refresh_token) {
    throw new GoogleAuthError("Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and run auth again.");
  }
  const missing = scopes.filter((s) => !(body.scope ?? "").split(" ").includes(s));
  if (missing.length > 0) {
    throw new GoogleAuthError(`The requested read-only permission was not granted: ${missing.map((s) => s.split("/").pop()).join(", ")}.`);
  }
  await saveToken(opts.tokenPath, { refreshToken: body.refresh_token, scope: body.scope ?? scopes.join(" "), savedAt: new Date().toISOString() });
}

/** Returns a function that yields a valid access token, refreshing it when needed. */
export function createTokenProvider(
  client: OAuthClientConfig,
  tokenPath: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const stored = await loadToken(tokenPath);
    if (!stored) {
      throw new GoogleAuthError("Google is not authorised yet. Run: invoices-mcp auth --google-credentials <credentials.json>");
    }
    const response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: stored.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      if (detail.error === "invalid_grant") {
        throw new GoogleAuthError(
          "Google authorisation expired or was revoked. Run auth again. (Google expires tokens after 7 days while an OAuth app is in 'Testing' mode.)",
        );
      }
      throw new GoogleAuthError(`Could not refresh the Google access token (HTTP ${response.status}).`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new GoogleAuthError("Google returned no access token.");
    cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return cached.token;
  };
}

/** True when the saved token was granted this scope (so a missing grant can be reported before any API call). */
export async function hasScope(tokenPath: string, scope: string): Promise<boolean> {
  const token = await loadToken(tokenPath);
  return token !== null && token.scope.split(" ").includes(scope);
}

export async function requireScope(tokenPath: string, scope: string, what: string, authHint: string): Promise<void> {
  if (!(await hasScope(tokenPath, scope))) {
    throw new GoogleAuthError(`${what} access has not been authorised. Run: invoices-mcp auth ${authHint}`);
  }
}
