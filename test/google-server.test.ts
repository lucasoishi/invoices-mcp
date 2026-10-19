import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GoogleAuthError } from "../src/google/auth.ts";
import type { DriveSyncReport } from "../src/google/drive-sync.ts";
import type { SyncReport } from "../src/google/gmail-sync.ts";
import { createServer, type DriveSync, type GmailSync } from "../src/server.ts";
import { InvoiceStore } from "../src/store.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleDir = path.join(root, "sample");

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function connect(gmail?: GmailSync) {
  const server = createServer(new InvoiceStore(sampleDir), "test", gmail);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const report: SyncReport = {
  messagesChecked: 2,
  attachmentsFound: 2,
  saved: ["gmail-abc123-2026-09.csv"],
  alreadyDownloaded: 1,
  rejected: [],
};

describe("sync_gmail_invoices tool", () => {
  it("does not exist unless Gmail was configured at startup", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("sync_gmail_invoices"));
    assert.equal(names.length, 7);
    await client.close();
  });

  it("is honestly annotated and cannot be pointed at a different search", async () => {
    const client = await connect({ sync: async () => report });
    const tool = (await client.listTools()).tools.find((t) => t.name === "sync_gmail_invoices")!;
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.openWorldHint, true);
    // The only parameter is a count: no query, label, sender, or path for an agent to steer.
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ["max_messages"]);
    await client.close();
  });

  it("returns the report and passes the requested limit through", async () => {
    let seen = 0;
    const client = await connect({
      sync: async ({ maxMessages }) => {
        seen = maxMessages;
        return report;
      },
    });
    const result = (await client.callTool({ name: "sync_gmail_invoices", arguments: { max_messages: 7 } })) as ToolResult;
    const data = JSON.parse(result.content[0]!.text);
    assert.equal(seen, 7);
    assert.deepEqual(data.saved, ["gmail-abc123-2026-09.csv"]);
    assert.match(data.next, /list_invoices/);
    await client.close();
  });

  it("uses 25 messages by default and rejects absurd limits", async () => {
    let seen = 0;
    const client = await connect({ sync: async ({ maxMessages }) => ((seen = maxMessages), report) });
    await client.callTool({ name: "sync_gmail_invoices", arguments: {} });
    assert.equal(seen, 25);
    const bad = (await client.callTool({ name: "sync_gmail_invoices", arguments: { max_messages: 100000 } })) as ToolResult;
    assert.equal(bad.isError, true);
    await client.close();
  });

  it("shows the user-facing auth message, and hides unexpected errors", async () => {
    const authFailing = await connect({
      sync: async () => {
        throw new GoogleAuthError("Gmail is not authorised yet. Run: invoices-mcp auth");
      },
    });
    const a = (await authFailing.callTool({ name: "sync_gmail_invoices", arguments: {} })) as ToolResult;
    assert.equal(a.isError, true);
    assert.match(a.content[0]!.text, /not authorised yet/);
    await authFailing.close();

    const crashing = await connect({
      sync: async () => {
        throw new Error("ECONNRESET token=SECRET-TOKEN-VALUE");
      },
    });
    const b = (await crashing.callTool({ name: "sync_gmail_invoices", arguments: {} })) as ToolResult;
    assert.equal(b.isError, true);
    assert.ok(!b.content[0]!.text.includes("SECRET-TOKEN-VALUE"), "internal error details must not reach the agent");
    await crashing.close();
  });
});

describe("startup validation", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", path.join(root, "src", "index.ts"), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      input: "",
    });

  it("refuses Gmail options given only halfway", () => {
    const r = run("--dir", sampleDir, "--gmail-query", "label:x");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /need --google-credentials/);
  });

  it("refuses an unscoped Gmail query at startup", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "nubank-cli-"));
    try {
      const creds = path.join(dir, "client.json");
      await writeFile(creds, JSON.stringify({ installed: { client_id: "i", client_secret: "s" } }));
      const r = run("--dir", sampleDir, "--gmail-credentials", creds, "--gmail-query", "has:attachment");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /from:, label: or subject:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("explains a missing credentials file without a stack trace", () => {
    const r = run("--dir", sampleDir, "--gmail-credentials", path.join(sampleDir, "nope.json"), "--gmail-query", "label:x");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not be read/);
    assert.ok(!r.stderr.includes("    at "));
  });

  it("auth needs credentials", () => {
    const r = run("auth");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--google-credentials/);
  });
});

describe("sync_drive_invoices tool", () => {
  const driveReport: DriveSyncReport = {
    filesInFolder: 3,
    candidates: 3,
    saved: ["drive-1qhc7WEkjQYU-Fatura_Itau.pdf"],
    alreadyDownloaded: 2,
    rejected: [],
  };

  async function connectBoth(gmail?: GmailSync, drive?: DriveSync) {
    const server = createServer(new InvoiceStore(sampleDir), "test", gmail, drive);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it("does not exist unless a Drive folder was configured at startup", async () => {
    const withGmailOnly = await connectBoth({ sync: async () => report });
    const names = (await withGmailOnly.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("sync_gmail_invoices"));
    assert.ok(!names.includes("sync_drive_invoices"));
    await withGmailOnly.close();
  });

  it("is honestly annotated, and its only parameter is how many files to look at (never which folder)", async () => {
    const client = await connectBoth(undefined, { sync: async () => driveReport });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("sync_gmail_invoices"));
    const tool = (await client.listTools()).tools.find((t) => t.name === "sync_drive_invoices")!;
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ["max_files"]);
    await client.close();
  });

  it("returns the report, passes the limit through, and can sit alongside the Gmail tool", async () => {
    let seen = 0;
    const client = await connectBoth(
      { sync: async () => report },
      { sync: async ({ maxFiles }) => ((seen = maxFiles), driveReport) },
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("sync_gmail_invoices") && names.includes("sync_drive_invoices"));
    const result = (await client.callTool({ name: "sync_drive_invoices", arguments: { max_files: 12 } })) as ToolResult;
    const data = JSON.parse(result.content[0]!.text);
    assert.equal(seen, 12);
    assert.deepEqual(data.saved, ["drive-1qhc7WEkjQYU-Fatura_Itau.pdf"]);
    assert.match(data.next, /list_invoices/);
    await client.close();
  });

  it("defaults to 50 files, and rejects absurd limits", async () => {
    let seen = 0;
    const client = await connectBoth(undefined, { sync: async ({ maxFiles }) => ((seen = maxFiles), driveReport) });
    await client.callTool({ name: "sync_drive_invoices", arguments: {} });
    assert.equal(seen, 50);
    const bad = (await client.callTool({ name: "sync_drive_invoices", arguments: { max_files: 100000 } })) as ToolResult;
    assert.equal(bad.isError, true);
    await client.close();
  });

  it("shows user-facing auth messages and hides unexpected errors", async () => {
    const authFailing = await connectBoth(undefined, {
      sync: async () => {
        throw new GoogleAuthError("Google Drive access has not been authorised. Run: invoices-mcp auth --scopes gmail,drive");
      },
    });
    const a = (await authFailing.callTool({ name: "sync_drive_invoices", arguments: {} })) as ToolResult;
    assert.equal(a.isError, true);
    assert.match(a.content[0]!.text, /has not been authorised/);
    await authFailing.close();

    const crashing = await connectBoth(undefined, {
      sync: async () => {
        throw new Error("ECONNRESET Authorization: Bearer SECRET-TOKEN-VALUE");
      },
    });
    const b = (await crashing.callTool({ name: "sync_drive_invoices", arguments: {} })) as ToolResult;
    assert.equal(b.isError, true);
    assert.ok(!b.content[0]!.text.includes("SECRET-TOKEN-VALUE"), "internal error details must not reach the agent");
    await crashing.close();
  });
});

describe("startup validation for Drive and shared credentials", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", path.join(root, "src", "index.ts"), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      input: "",
    });

  async function withCredentials<T>(fn: (credentials: string) => T | Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "invoices-cli-"));
    try {
      const credentials = path.join(dir, "client.json");
      await writeFile(credentials, JSON.stringify({ installed: { client_id: "i", client_secret: "s" } }));
      return await fn(credentials);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("refuses --drive-folder without credentials", () => {
    const r = run("--dir", sampleDir, "--drive-folder", "1AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /need --google-credentials/);
  });

  it("refuses credentials with nothing to read", async () => {
    await withCredentials((credentials) => {
      const r = run("--dir", sampleDir, "--google-credentials", credentials);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /nothing to read/);
    });
  });

  it("refuses a Drive folder that is not a plain id or folder link, at startup", async () => {
    await withCredentials((credentials) => {
      const r = run("--dir", sampleDir, "--google-credentials", credentials, "--drive-folder", "x' or name contains 'y");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /folder id/);
    });
  });

  it("still accepts the older --gmail-credentials name", async () => {
    await withCredentials((credentials) => {
      const r = run("--dir", sampleDir, "--gmail-credentials", credentials, "--gmail-query", "has:attachment");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /from:, label: or subject:/); // got as far as validating the query
    });
  });

  it("rejects an unknown sign-in scope", async () => {
    await withCredentials((credentials) => {
      const r = run("auth", "--google-credentials", credentials, "--scopes", "gmail,calendar");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Unknown scope "calendar"/);
    });
  });
});
