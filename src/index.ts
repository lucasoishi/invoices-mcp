#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describeSupport } from "./banks/index.js";
import { UserFacingError } from "./errors.js";
import { createServer, type DriveSync, type GmailSync } from "./server.js";
import { InvoiceStore } from "./store.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `invoices-mcp ${version}

A local MCP server for your bank invoices. Supported: ${describeSupport()}.
By default it is read-only and makes no network requests: files are read from one folder.

Usage:
  invoices-mcp --dir <folder with invoice files>
  INVOICES_DIR=<folder> invoices-mcp

Optional Google sources (each is off unless configured; both need --google-credentials):
  --google-credentials <file>  OAuth "Desktop app" credentials JSON from Google Cloud Console
  --gmail-query <query>        Gmail: search for the emails to read; must contain from:, label: or subject:
                               e.g. "label:invoices"
  --drive-folder <id or link>  Drive: the ONE folder to read invoice files from
  invoices-mcp auth --google-credentials <file> [--scopes gmail,drive]
                               one-time browser sign-in, read-only (default scope: gmail)

Options:
  --dir <path>   Folder containing the invoice files (.csv / .pdf); files fetched from Google are saved here too
  --help         Show this message
  --version      Show the version

Environment:
  INVOICES_DIR, INVOICES_GOOGLE_CREDENTIALS, INVOICES_GMAIL_QUERY, INVOICES_DRIVE_FOLDER, INVOICES_GOOGLE_TOKEN
  INVOICES_PDF_PASSWORD   only needed if your PDF statements are password protected
  (--gmail-credentials / INVOICES_GMAIL_CREDENTIALS / INVOICES_GMAIL_TOKEN still work as older names)
`;

/** First of the flags that is present, else the first environment variable that is set. */
function option(argv: string[], flags: string[], envs: string[]): string | undefined {
  for (const flag of flags) {
    const i = argv.indexOf(flag);
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
  }
  for (const env of envs) if (process.env[env]) return process.env[env];
  return undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const credentials = option(argv, ["--google-credentials", "--gmail-credentials"], ["INVOICES_GOOGLE_CREDENTIALS", "INVOICES_GMAIL_CREDENTIALS"]);
  const gmailQuery = option(argv, ["--gmail-query"], ["INVOICES_GMAIL_QUERY"]);
  const driveFolderArg = option(argv, ["--drive-folder"], ["INVOICES_DRIVE_FOLDER"]);
  const pdfPassword = process.env["INVOICES_PDF_PASSWORD"] || undefined;
  const tokenPathFromEnv = process.env["INVOICES_GOOGLE_TOKEN"] ?? process.env["INVOICES_GMAIL_TOKEN"];

  if (argv[0] === "auth") {
    if (!credentials) throw new UserFacingError("auth needs --google-credentials <file>.");
    const wanted = (option(argv, ["--scopes"], []) ?? "gmail").split(",").map((s) => s.trim().toLowerCase());
    const { DRIVE_SCOPE, GMAIL_SCOPE, defaultTokenPath, loadClientConfig, runAuthFlow } = await import("./google/auth.js");
    const known: Record<string, string> = { gmail: GMAIL_SCOPE, drive: DRIVE_SCOPE };
    const unknown = wanted.filter((w) => !known[w]);
    if (unknown.length > 0) throw new UserFacingError(`Unknown scope "${unknown.join(", ")}". Use --scopes gmail, drive, or gmail,drive.`);
    const tokenPath = tokenPathFromEnv ?? defaultTokenPath();
    await runAuthFlow({
      client: await loadClientConfig(path.resolve(credentials)),
      tokenPath,
      scopes: wanted.map((w) => known[w]!),
    });
    process.stderr.write(
      `Authorised (read-only: ${wanted.join(" + ")}). Token saved to ${tokenPath}\nTo revoke: https://myaccount.google.com/permissions\n`,
    );
    return;
  }

  const dirArg = option(argv, ["--dir"], ["INVOICES_DIR"]);
  if (!dirArg) {
    // stdout is reserved for the MCP protocol, so diagnostics go to stderr.
    process.stderr.write(`No folder configured.\n\n${USAGE}`);
    process.exit(1);
  }
  const dir = path.resolve(dirArg);

  if (credentials && !gmailQuery && !driveFolderArg) {
    throw new UserFacingError("--google-credentials was given but there is nothing to read: add --gmail-query and/or --drive-folder.");
  }
  if (!credentials && (gmailQuery || driveFolderArg)) {
    throw new UserFacingError("Gmail and Drive sync need --google-credentials <file>.");
  }

  let gmail: GmailSync | undefined;
  let drive: DriveSync | undefined;
  if (credentials) {
    const [auth, gmailApi, driveApi] = await Promise.all([
      import("./google/auth.js"),
      import("./google/gmail-api.js"),
      import("./google/drive-api.js"),
    ]);
    const client = await auth.loadClientConfig(path.resolve(credentials));
    const tokenPath = tokenPathFromEnv ?? auth.defaultTokenPath();
    const token = auth.createTokenProvider(client, tokenPath);
    const hint = `--google-credentials <file> --scopes gmail,drive`;

    if (gmailQuery) {
      const { assertScopedQuery, syncGmailInvoices } = await import("./google/gmail-sync.js");
      assertScopedQuery(gmailQuery); // fail at startup, not on first use
      const api = new gmailApi.GmailApi(token);
      gmail = {
        sync: async ({ maxMessages }) => {
          await auth.requireScope(tokenPath, auth.GMAIL_SCOPE, "Gmail", hint);
          return syncGmailInvoices(api, gmailQuery, dir, { maxMessages, pdfPassword });
        },
      };
    }
    if (driveFolderArg) {
      const { syncDriveInvoices } = await import("./google/drive-sync.js");
      const folderId = driveApi.parseFolderId(driveFolderArg); // fail at startup, not on first use
      const api = new driveApi.DriveApi(token);
      drive = {
        sync: async ({ maxFiles }) => {
          await auth.requireScope(tokenPath, auth.DRIVE_SCOPE, "Google Drive", hint);
          return syncDriveInvoices(api, folderId, dir, { maxFiles, pdfPassword });
        },
      };
    }
  }

  const server = createServer(new InvoiceStore(dir, { pdfPassword }), version, gmail, drive);
  await server.connect(new StdioServerTransport());
  const sources = [gmail && "Gmail", drive && "Drive"].filter(Boolean).join(" + ");
  process.stderr.write(
    `invoices-mcp ${version} ready (folder: ${path.basename(dir)}, ${sources ? `${sources} sync ON, read-only` : "no network"})\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof UserFacingError ? error.message : "Unexpected error.";
  process.stderr.write(`Fatal: ${message}\n`);
  process.exit(1);
});
