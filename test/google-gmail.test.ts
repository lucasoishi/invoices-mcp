/**
 * Gmail integration, tested entirely against fakes: no real Google account or network is used.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { GmailApi, type AttachmentRef, type GmailSource } from "../src/google/gmail-api.ts";
import {
  GMAIL_SCOPE,
  GoogleAuthError,
  createTokenProvider,
  loadClientConfig,
  loadToken,
  runAuthFlow,
  saveToken,
} from "../src/google/auth.ts";
import { assertScopedQuery, buildQuery, safeBaseName, syncGmailInvoices } from "../src/google/gmail-sync.ts";
import { ITAU_PAGE_1, ITAU_PAGE_2 } from "./helpers/itau-fixture.ts";
import { makePdf } from "./helpers/pdf.ts";

const NUBANK_CSV = "date,category,title,amount\n2026-09-01,restaurante,Cafe,19.00\n2026-09-02,lazer,Cinema,64.00\n";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "nubank-gmail-"));
}
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir();
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** In-memory stand-in for Gmail. */
class FakeGmail implements GmailSource {
  downloads: string[] = [];
  queries: string[] = [];
  constructor(private readonly messages: Record<string, { ref: Omit<AttachmentRef, "messageId">; data: string | Buffer }[]>) {}
  async listMessageIds(query: string): Promise<string[]> {
    this.queries.push(query);
    return Object.keys(this.messages);
  }
  async listAttachments(messageId: string): Promise<AttachmentRef[]> {
    return (this.messages[messageId] ?? []).map((m) => ({ ...m.ref, messageId }));
  }
  async downloadAttachment(ref: AttachmentRef): Promise<Buffer> {
    this.downloads.push(`${ref.messageId}/${ref.attachmentId}`);
    const found = this.messages[ref.messageId]!.find((m) => m.ref.attachmentId === ref.attachmentId)!;
    return Buffer.isBuffer(found.data) ? found.data : Buffer.from(found.data, "utf8");
  }
}

const pdfRef = (filename: string, attachmentId = "p1", size = 3000): Omit<AttachmentRef, "messageId"> => ({
  attachmentId,
  filename,
  mimeType: "application/pdf",
  size,
});

const csvRef = (filename: string, attachmentId = "a1", size = 200): Omit<AttachmentRef, "messageId"> => ({
  attachmentId,
  filename,
  mimeType: "text/csv",
  size,
});

describe("query rules", () => {
  it("requires a from:, label: or subject: qualifier", () => {
    assert.throws(() => assertScopedQuery("has:attachment"), /from:, label: or subject:/);
    assert.throws(() => assertScopedQuery("nubank"), /from:, label: or subject:/);
    assertScopedQuery("label:nubank-csv");
    assertScopedQuery("from:me subject:fatura");
  });
  it("always narrows to CSV attachments", () => {
    assert.equal(buildQuery(" label:nubank-csv "), "(label:nubank-csv) has:attachment (filename:csv OR filename:pdf)");
  });
});

describe("safeBaseName", () => {
  it("cannot escape the folder or contain odd characters", () => {
    assert.equal(safeBaseName("../../evil.csv"), "evil");
    assert.equal(safeBaseName("C:\\Users\\x\\fatura setembro.CSV"), "fatura-setembro");
    assert.equal(safeBaseName("Fátura 2026-09.csv"), "Fatura-2026-09");
    assert.equal(safeBaseName("...csv"), "attachment");
    assert.ok(safeBaseName("x".repeat(500)).length <= 60);
  });
});

describe("syncGmailInvoices", () => {
  it("saves recognised bank invoices and nothing else", async () => {
    await withTemp(async (dir) => {
      const gmail = new FakeGmail({
        abc123: [
          { ref: csvRef("2026-09.csv", "a1"), data: NUBANK_CSV },
          { ref: csvRef("planilha-trabalho.csv", "a2"), data: "nome,salario\nAna,1000\n" },
          { ref: pdfRef("boleto.pdf", "a3"), data: "%PDF-this is not really a pdf" },
          { ref: { attachmentId: "a4", filename: "logo.png", mimeType: "image/png", size: 900 }, data: "png" },
        ],
      });
      const report = await syncGmailInvoices(gmail, "label:nubank-csv", dir, { maxMessages: 10 });

      assert.deepEqual(report.saved, ["gmail-abc123-2026-09.csv"]);
      assert.equal(report.attachmentsFound, 3); // the image is not a candidate
      assert.deepEqual(
        [...report.rejected].sort((a, b) => (a.reason < b.reason ? -1 : 1)),
        [
          { reason: "PDF could not be opened", count: 1 },
          { reason: "not a recognised bank invoice", count: 1 },
        ],
      );
      assert.deepEqual(await readdir(dir), ["gmail-abc123-2026-09.csv"]);
      assert.equal(await readFile(path.join(dir, "gmail-abc123-2026-09.csv"), "utf8"), NUBANK_CSV);
      assert.ok(!gmail.downloads.includes("abc123/a4"), "images are never downloaded");
    });
  });

  it("saves an Itaú PDF statement as a .pdf, and rejects a PDF from an unsupported bank", async () => {
    await withTemp(async (dir) => {
      const itauPdf = makePdf([ITAU_PAGE_1, ITAU_PAGE_2]);
      const otherPdf = makePdf([["Extrato Banco Exemplo", "01/09 COMPRA 10,00"]]);
      const gmail = new FakeGmail({
        abc123: [
          { ref: pdfRef("Fatura Itaú setembro.pdf", "p1"), data: itauPdf },
          { ref: pdfRef("extrato.pdf", "p2"), data: otherPdf },
        ],
      });
      const report = await syncGmailInvoices(gmail, "from:itau", dir, { maxMessages: 10 });
      assert.deepEqual(report.saved, ["gmail-abc123-Fatura-Itau-setembro.pdf"]);
      assert.deepEqual(report.rejected, [{ reason: "not a recognised bank invoice", count: 1 }]);
      assert.deepEqual(await readFile(path.join(dir, "gmail-abc123-Fatura-Itau-setembro.pdf")), itauPdf);
    });
  });

  it("is idempotent and never overwrites a file", async () => {
    await withTemp(async (dir) => {
      const gmail = new FakeGmail({ abc123: [{ ref: csvRef("2026-09.csv"), data: NUBANK_CSV }] });
      await syncGmailInvoices(gmail, "label:x", dir, { maxMessages: 10 });
      const edited = path.join(dir, "gmail-abc123-2026-09.csv");
      await writeFile(edited, "my own edit");
      const second = await syncGmailInvoices(gmail, "label:x", dir, { maxMessages: 10 });
      assert.equal(second.alreadyDownloaded, 1);
      assert.deepEqual(second.saved, []);
      assert.equal(await readFile(edited, "utf8"), "my own edit");
    });
  });

  it("keeps hostile file names inside the folder", async () => {
    await withTemp(async (dir) => {
      const gmail = new FakeGmail({ abc123: [{ ref: csvRef("../../../evil.csv"), data: NUBANK_CSV }] });
      const report = await syncGmailInvoices(gmail, "label:x", dir, { maxMessages: 10 });
      assert.deepEqual(report.saved, ["gmail-abc123-evil.csv"]);
      assert.deepEqual(await readdir(dir), ["gmail-abc123-evil.csv"]);
    });
  });

  it("refuses unexpected message ids", async () => {
    await withTemp(async (dir) => {
      const gmail = new FakeGmail({ "../etc": [{ ref: csvRef("x.csv"), data: NUBANK_CSV }] });
      const report = await syncGmailInvoices(gmail, "label:x", dir, { maxMessages: 10 });
      assert.deepEqual(report.saved, []);
      assert.equal(report.rejected[0]!.reason, "unexpected message id");
      assert.equal(gmail.downloads.length, 0);
    });
  });

  it("does not download attachments over the size cap", async () => {
    await withTemp(async (dir) => {
      const gmail = new FakeGmail({ abc123: [{ ref: csvRef("big.csv", "a1", 6 * 1024 * 1024), data: NUBANK_CSV }] });
      const report = await syncGmailInvoices(gmail, "label:x", dir, { maxMessages: 10 });
      assert.deepEqual(report.saved, []);
      assert.equal(gmail.downloads.length, 0);
    });
  });

  it("stops at the per-run save limit", async () => {
    await withTemp(async (dir) => {
      const gmail = new FakeGmail({
        a11111: [{ ref: csvRef("a.csv"), data: NUBANK_CSV }],
        b22222: [{ ref: csvRef("b.csv"), data: NUBANK_CSV }],
      });
      const report = await syncGmailInvoices(gmail, "label:x", dir, { maxMessages: 10, maxSavedFiles: 1 });
      assert.equal(report.saved.length, 1);
      assert.equal(report.rejected[0]!.reason, "save limit reached for this run");
    });
  });

  it("sends only the scoped query to Gmail", async () => {
    await withTemp(async (dir) => {
      const gmail = new FakeGmail({});
      await syncGmailInvoices(gmail, "label:nubank-csv", dir, { maxMessages: 5 });
      assert.deepEqual(gmail.queries, ["(label:nubank-csv) has:attachment (filename:csv OR filename:pdf)"]);
    });
  });

  it("refuses an unscoped query before contacting Gmail", async () => {
    await withTemp(async (dir) => {
      const gmail = new FakeGmail({});
      await assert.rejects(syncGmailInvoices(gmail, "has:attachment", dir, { maxMessages: 5 }));
      assert.equal(gmail.queries.length, 0);
    });
  });
});

describe("GmailApi", () => {
  const message = {
    id: "abc123",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", filename: "", body: { size: 10 } }] },
        { filename: "2026-09.csv", mimeType: "text/csv", body: { attachmentId: "att1", size: 120 } },
        { mimeType: "multipart/related", parts: [{ filename: "nested.csv", mimeType: "text/csv", body: { attachmentId: "att2", size: 80 } }] },
      ],
    },
  };

  function fakeFetch(calls: { url: URL; auth: string | null }[], status = 200): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (status !== 200) return json({}, status);
      if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "abc123" }] });
      if (url.pathname.includes("/attachments/")) return json({ data: Buffer.from(NUBANK_CSV).toString("base64url") });
      return json(message);
    }) as typeof fetch;
  }

  it("lists messages with the bearer token and finds nested attachments", async () => {
    const calls: { url: URL; auth: string | null }[] = [];
    const api = new GmailApi(async () => "tok", fakeFetch(calls));
    assert.deepEqual(await api.listMessageIds("label:x", 7), ["abc123"]);
    const refs = await api.listAttachments("abc123");
    assert.deepEqual(refs.map((r) => r.attachmentId), ["att1", "att2"]);

    assert.equal(calls[0]!.url.searchParams.get("maxResults"), "7");
    assert.ok(calls.every((c) => c.url.host === "gmail.googleapis.com" && c.auth === "Bearer tok"));
  });

  it("never asks Gmail for message body text", async () => {
    const calls: { url: URL; auth: string | null }[] = [];
    await new GmailApi(async () => "tok", fakeFetch(calls)).listAttachments("abc123");
    const fields = calls[0]!.url.searchParams.get("fields")!;
    assert.ok(fields.includes("attachmentId"));
    assert.ok(!/\bdata\b/.test(fields), "the fields mask must not include body.data");
  });

  it("decodes attachment data", async () => {
    const api = new GmailApi(async () => "tok", fakeFetch([]));
    const data = await api.downloadAttachment({ messageId: "abc123", attachmentId: "att1", filename: "x.csv", mimeType: "text/csv", size: 1 });
    assert.equal(data.toString("utf8"), NUBANK_CSV);
  });

  it("turns 401/403 into a helpful auth error", async () => {
    const api = new GmailApi(async () => "tok", fakeFetch([], 403));
    await assert.rejects(api.listMessageIds("label:x", 5), GoogleAuthError);
  });
});

describe("OAuth", () => {
  const goodCreds = {
    installed: { client_id: "id.apps.googleusercontent.com", client_secret: "shh", token_uri: "https://oauth2.googleapis.com/token" },
  };

  it("reads Google's credentials file", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "client.json");
      await writeFile(file, JSON.stringify(goodCreds));
      assert.deepEqual(await loadClientConfig(file), { clientId: "id.apps.googleusercontent.com", clientSecret: "shh" });
    });
  });

  it("refuses a credentials file that points the token endpoint elsewhere", async () => {
    await withTemp(async (dir) => {
      const file = path.join(dir, "client.json");
      await writeFile(file, JSON.stringify({ installed: { ...goodCreds.installed, token_uri: "https://evil.example/token" } }));
      await assert.rejects(loadClientConfig(file), /Unexpected token_uri/);
    });
  });

  it("refreshes an access token once and caches it", async () => {
    await withTemp(async (dir) => {
      const tokenPath = path.join(dir, "token.json");
      await saveToken(tokenPath, { refreshToken: "r1", scope: GMAIL_SCOPE, savedAt: "now" });
      let refreshes = 0;
      let clock = 1_000_000;
      const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        refreshes++;
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "r1");
        return json({ access_token: `access-${refreshes}`, expires_in: 3600 });
      }) as typeof fetch;
      const provider = createTokenProvider({ clientId: "id", clientSecret: "s" }, tokenPath, fetchFn, () => clock);

      assert.equal(await provider(), "access-1");
      assert.equal(await provider(), "access-1");
      assert.equal(refreshes, 1);
      clock += 3_600_000; // an hour later
      assert.equal(await provider(), "access-2");
    });
  });

  it("explains how to recover from a missing, expired or revoked token", async () => {
    await withTemp(async (dir) => {
      const tokenPath = path.join(dir, "token.json");
      const never = (async () => json({})) as typeof fetch;
      await assert.rejects(createTokenProvider({ clientId: "i", clientSecret: "s" }, tokenPath, never)(), /Run: invoices-mcp auth/);

      await saveToken(tokenPath, { refreshToken: "r1", scope: GMAIL_SCOPE, savedAt: "now" });
      const revoked = (async () => json({ error: "invalid_grant" }, 400)) as typeof fetch;
      await assert.rejects(createTokenProvider({ clientId: "i", clientSecret: "s" }, tokenPath, revoked)(), /expired or was revoked/);
    });
  });

  it("runs the browser flow with PKCE, a state check and the read-only scope", async () => {
    await withTemp(async (dir) => {
      const tokenPath = path.join(dir, "token.json");
      let exchangedBody: URLSearchParams | undefined;
      let authParams: URLSearchParams | undefined;

      const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        exchangedBody = new URLSearchParams(String(init?.body));
        return json({ refresh_token: "refresh-xyz", access_token: "SHOULD-NOT-BE-STORED", scope: GMAIL_SCOPE });
      }) as typeof fetch;

      await runAuthFlow({
        client: { clientId: "id", clientSecret: "s" },
        tokenPath,
        fetchFn,
        onAuthUrl: (url) => {
          const parsed = new URL(url);
          assert.equal(parsed.host, "accounts.google.com");
          authParams = parsed.searchParams;
          const redirect = new URL(parsed.searchParams.get("redirect_uri")!);
          assert.equal(redirect.hostname, "127.0.0.1");
          // Play the part of the browser: Google redirects back with a code and our state.
          void fetch(`${redirect.origin}/?code=the-code&state=${parsed.searchParams.get("state")}`);
        },
      });

      assert.equal(authParams!.get("scope"), GMAIL_SCOPE);
      assert.equal(authParams!.get("code_challenge_method"), "S256");
      const verifier = exchangedBody!.get("code_verifier")!;
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), authParams!.get("code_challenge"));
      assert.equal(exchangedBody!.get("code"), "the-code");

      const saved = await loadToken(tokenPath);
      assert.equal(saved?.refreshToken, "refresh-xyz");
      assert.ok(!(await readFile(tokenPath, "utf8")).includes("SHOULD-NOT-BE-STORED"), "access tokens are never stored");
    });
  });

  it("rejects a redirect with the wrong state", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(
        runAuthFlow({
          client: { clientId: "id", clientSecret: "s" },
          tokenPath: path.join(dir, "token.json"),
          fetchFn: (async () => json({})) as typeof fetch,
          onAuthUrl: (url) => {
            const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
            void fetch(`${redirect.origin}/?code=x&state=forged`);
          },
        }),
        /state mismatch/,
      );
    });
  });

  it("refuses to save a token when the read-only scope was not granted", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(
        runAuthFlow({
          client: { clientId: "id", clientSecret: "s" },
          tokenPath: path.join(dir, "token.json"),
          fetchFn: (async () => json({ refresh_token: "r", scope: "openid" })) as typeof fetch,
          onAuthUrl: (url) => {
            const p = new URL(url).searchParams;
            void fetch(`${new URL(p.get("redirect_uri")!).origin}/?code=c&state=${p.get("state")}`);
          },
        }),
        /not granted/,
      );
    });
  });
});
