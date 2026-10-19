/**
 * Google Drive source, tested entirely against fakes: no real Google account or network is used.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DRIVE_SCOPE, GMAIL_SCOPE, GoogleApiError, GoogleAuthError, hasScope, loadToken, requireScope, runAuthFlow, saveToken } from "../src/google/auth.ts";
import { DriveApi, assertFolderId, parseFolderId, type DriveFile, type DriveSource } from "../src/google/drive-api.ts";
import { syncDriveInvoices } from "../src/google/drive-sync.ts";
import { ITAU_PAGE_1, ITAU_PAGE_2 } from "./helpers/itau-fixture.ts";
import { makePdf } from "./helpers/pdf.ts";

const FOLDER = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const NUBANK_CSV = "date,title,amount\n2026-09-01,Loja,\"19,00\"\n2026-09-02,Cinema,\"64,00\"\n";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "invoices-drive-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const file = (over: Partial<DriveFile> & { name: string }): DriveFile => ({
  id: "1qhc7WEkjQYUuJPDpwN-t6ip5bfkDbNCE",
  mimeType: "application/pdf",
  size: 3000,
  parents: [FOLDER],
  ...over,
});

/** In-memory stand-in for Drive. */
class FakeDrive implements DriveSource {
  downloads: string[] = [];
  listed: { folderId: string; max: number }[] = [];
  constructor(private readonly files: { file: DriveFile; data: string | Buffer }[]) {}
  async listFolder(folderId: string, max: number): Promise<DriveFile[]> {
    this.listed.push({ folderId, max });
    return this.files.map((f) => f.file);
  }
  async download(f: DriveFile): Promise<Buffer> {
    this.downloads.push(f.id);
    const found = this.files.find((x) => x.file.id === f.id)!;
    return Buffer.isBuffer(found.data) ? found.data : Buffer.from(found.data, "utf8");
  }
}

const itauPdf = () => makePdf([ITAU_PAGE_1, ITAU_PAGE_2]);

describe("parseFolderId / assertFolderId", () => {
  it("accepts a folder id or a folder link", () => {
    assert.equal(parseFolderId(FOLDER), FOLDER);
    assert.equal(parseFolderId(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`), FOLDER);
    assert.equal(parseFolderId(`  ${FOLDER}  `), FOLDER);
  });

  it("refuses anything that could alter the Drive search query", () => {
    for (const bad of ["", "short", "abc' or name contains 'x", `${FOLDER}' in parents or '1`, "1AbCdEfGhIjKlMnOpQrStUvWxYz012345 extra", "../etc/passwd"]) {
      assert.throws(() => parseFolderId(bad), /folder id/, JSON.stringify(bad));
    }
    assert.throws(() => assertFolderId("has space in it........"));
  });
});

describe("syncDriveInvoices", () => {
  it("saves recognised bank invoices and nothing else", async () => {
    await withTemp(async (dir) => {
      const drive = new FakeDrive([
        { file: file({ id: "1qhc7WEkjQYUuJPDpwN-t6ip5bfkDbNCE", name: "Fatura_Itau_20261019-003615.pdf" }), data: itauPdf() },
        { file: file({ id: "1ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456", name: "2026-09.csv", mimeType: "text/csv" }), data: NUBANK_CSV },
        { file: file({ id: "1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ12345", name: "planilha.csv", mimeType: "text/csv" }), data: "nome,salario\nAna,1000\n" },
        { file: file({ id: "1YYYYYYYYYYYYYYYYYYYYYYYYYYYY12345", name: "selfie.png", mimeType: "image/png" }), data: "png" },
        { file: file({ id: "1XXXXXXXXXXXXXXXXXXXXXXXXXXXX12345", name: "subfolder", mimeType: "application/vnd.google-apps.folder" }), data: "" },
        { file: file({ id: "1WWWWWWWWWWWWWWWWWWWWWWWWWWWW12345", name: "Orçamento", mimeType: "application/vnd.google-apps.spreadsheet" }), data: "" },
      ]);
      const report = await syncDriveInvoices(drive, FOLDER, dir, { maxFiles: 50 });

      assert.equal(report.filesInFolder, 6);
      assert.equal(report.candidates, 3); // the PDF and the two CSVs; not the image, the folder or the Sheet
      assert.deepEqual(report.saved.sort(), ["drive-1ABCDEFGHIJK-2026-09.csv", "drive-1qhc7WEkjQYU-Fatura_Itau_20261019-003615.pdf"]);
      assert.deepEqual(
        [...report.rejected].sort((a, b) => (a.reason < b.reason ? -1 : 1)),
        [
          { reason: "Google Docs/Sheets file (export it as CSV or PDF)", count: 1 },
          { reason: "not a recognised bank invoice", count: 1 },
        ],
      );
      assert.ok(!drive.downloads.includes("1YYYYYYYYYYYYYYYYYYYYYYYYYYYY12345"), "images are never downloaded");
      assert.deepEqual(await readdir(dir), report.saved.sort());
      assert.deepEqual(await readFile(path.join(dir, "drive-1qhc7WEkjQYU-Fatura_Itau_20261019-003615.pdf")), itauPdf());
    });
  });

  it("looks only in the configured folder and passes the limit along", async () => {
    await withTemp(async (dir) => {
      const drive = new FakeDrive([]);
      await syncDriveInvoices(drive, FOLDER, dir, { maxFiles: 7 });
      assert.deepEqual(drive.listed, [{ folderId: FOLDER, max: 7 }]);
    });
  });

  it("refuses an invalid folder id before contacting Drive", async () => {
    await withTemp(async (dir) => {
      const drive = new FakeDrive([]);
      await assert.rejects(syncDriveInvoices(drive, "x' or '1'='1", dir, { maxFiles: 5 }));
      assert.equal(drive.listed.length, 0);
    });
  });

  it("is idempotent and never overwrites a file", async () => {
    await withTemp(async (dir) => {
      const drive = new FakeDrive([{ file: file({ name: "2026-09.csv", mimeType: "text/csv" }), data: NUBANK_CSV }]);
      await syncDriveInvoices(drive, FOLDER, dir, { maxFiles: 10 });
      const saved = path.join(dir, (await readdir(dir))[0]!);
      await writeFile(saved, "my own edit");
      const second = await syncDriveInvoices(drive, FOLDER, dir, { maxFiles: 10 });
      assert.equal(second.alreadyDownloaded, 1);
      assert.deepEqual(second.saved, []);
      assert.equal(await readFile(saved, "utf8"), "my own edit");
      assert.equal(drive.downloads.length, 1, "an existing file is not downloaded again");
    });
  });

  it("keeps hostile file names inside the folder", async () => {
    await withTemp(async (dir) => {
      const drive = new FakeDrive([{ file: file({ name: "../../../evil.csv", mimeType: "text/csv" }), data: NUBANK_CSV }]);
      const report = await syncDriveInvoices(drive, FOLDER, dir, { maxFiles: 10 });
      assert.deepEqual(report.saved, ["drive-1qhc7WEkjQYU-evil.csv"]);
      assert.deepEqual(await readdir(dir), ["drive-1qhc7WEkjQYU-evil.csv"]);
    });
  });

  it("refuses unexpected file ids", async () => {
    await withTemp(async (dir) => {
      const drive = new FakeDrive([{ file: file({ id: "../../etc/passwd/xxxxx", name: "a.csv", mimeType: "text/csv" }), data: NUBANK_CSV }]);
      const report = await syncDriveInvoices(drive, FOLDER, dir, { maxFiles: 10 });
      assert.deepEqual(report.saved, []);
      assert.equal(report.rejected[0]!.reason, "unexpected file id");
      assert.equal(drive.downloads.length, 0);
    });
  });

  it("ignores a file Drive reports as living somewhere other than the configured folder", async () => {
    await withTemp(async (dir) => {
      const drive = new FakeDrive([{ file: file({ name: "a.csv", mimeType: "text/csv", parents: ["1SOMEOTHERFOLDERIDxxxxxxxxxxxxx"] }), data: NUBANK_CSV }]);
      const report = await syncDriveInvoices(drive, FOLDER, dir, { maxFiles: 10 });
      assert.deepEqual(report.saved, []);
      assert.equal(report.rejected[0]!.reason, "not directly inside the configured folder");
      assert.equal(drive.downloads.length, 0);
    });
  });

  it("does not download files over the size cap", async () => {
    await withTemp(async (dir) => {
      const drive = new FakeDrive([{ file: file({ name: "big.csv", mimeType: "text/csv", size: 6 * 1024 * 1024 }), data: NUBANK_CSV }]);
      const report = await syncDriveInvoices(drive, FOLDER, dir, { maxFiles: 10 });
      assert.deepEqual(report.saved, []);
      assert.equal(drive.downloads.length, 0);
    });
  });

  it("stops at the per-run save limit", async () => {
    await withTemp(async (dir) => {
      const drive = new FakeDrive([
        { file: file({ id: "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA111", name: "a.csv", mimeType: "text/csv" }), data: NUBANK_CSV },
        { file: file({ id: "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB222", name: "b.csv", mimeType: "text/csv" }), data: NUBANK_CSV },
      ]);
      const report = await syncDriveInvoices(drive, FOLDER, dir, { maxFiles: 10, maxSavedFiles: 1 });
      assert.equal(report.saved.length, 1);
      assert.equal(report.rejected[0]!.reason, "save limit reached for this run");
    });
  });
});

describe("DriveApi", () => {
  type Call = { url: URL; method: string | undefined; auth: string | null };
  const listPage = (ids: string[], next?: string) => ({
    files: ids.map((id) => ({ id, name: `${id}.pdf`, mimeType: "application/pdf", size: "1234", parents: [FOLDER] })),
    ...(next && { nextPageToken: next }),
  });

  function fakeFetch(calls: Call[], pages: unknown[], status = 200, body = ""): typeof fetch {
    let page = 0;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, method: init?.method, auth: new Headers(init?.headers).get("authorization") });
      if (status !== 200) return new Response(body, { status });
      if (url.searchParams.get("alt") === "media") return new Response(Buffer.from(NUBANK_CSV));
      return json(pages[Math.min(page++, pages.length - 1)]);
    }) as typeof fetch;
  }

  it("lists one folder with the bearer token, read-only", async () => {
    const calls: Call[] = [];
    const api = new DriveApi(async () => "tok", fakeFetch(calls, [listPage(["1aaaaaaaaaaaaaaaaaaaaa"])]));
    const files = await api.listFolder(FOLDER, 50);

    assert.deepEqual(files.map((f) => [f.id, f.size, f.parents]), [["1aaaaaaaaaaaaaaaaaaaaa", 1234, [FOLDER]]]);
    const { url, method, auth } = calls[0]!;
    assert.equal(url.origin + url.pathname, "https://www.googleapis.com/drive/v3/files");
    assert.equal(url.searchParams.get("q"), `'${FOLDER}' in parents and trashed = false`);
    assert.match(url.searchParams.get("fields")!, /files\(id,name,mimeType,size,parents\)/);
    assert.equal(method, undefined, "list must be a plain GET");
    assert.equal(auth, "Bearer tok");
  });

  it("follows pages until it has enough files, and not further", async () => {
    const calls: Call[] = [];
    const api = new DriveApi(
      async () => "tok",
      fakeFetch(calls, [listPage(["1aaaaaaaaaaaaaaaaaaaaa", "1bbbbbbbbbbbbbbbbbbbbb"], "NEXT"), listPage(["1ccccccccccccccccccccc", "1ddddddddddddddddddddd"], "MORE")]),
    );
    const files = await api.listFolder(FOLDER, 3);
    assert.equal(files.length, 3);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url.searchParams.get("pageToken"), "NEXT");
  });

  it("downloads a file's bytes with a plain GET", async () => {
    const calls: Call[] = [];
    const api = new DriveApi(async () => "tok", fakeFetch(calls, []));
    const data = await api.download(file({ id: "1qhc7WEkjQYUuJPDpwN-t6ip5bfkDbNCE", name: "x.csv" }));
    assert.equal(data.toString("utf8"), NUBANK_CSV);
    assert.equal(calls[0]!.method, undefined);
    assert.equal(calls[0]!.url.pathname, "/drive/v3/files/1qhc7WEkjQYUuJPDpwN-t6ip5bfkDbNCE");
  });

  it("explains a disabled Drive API, a missing grant, a missing folder and a server error", async () => {
    const call = (status: number, body = "") => new DriveApi(async () => "tok", fakeFetch([], [], status, body)).listFolder(FOLDER, 5);
    await assert.rejects(call(403, '{"error":{"errors":[{"reason":"accessNotConfigured"}]}}'), /Drive API is not enabled/);
    await assert.rejects(call(403, "{}"), (e: Error) => e instanceof GoogleAuthError && /--scopes gmail,drive/.test(e.message));
    await assert.rejects(call(401), GoogleAuthError);
    await assert.rejects(call(404), /could not find that folder/);
    await assert.rejects(call(500), GoogleApiError);
  });
});

describe("Google scopes", () => {
  const fetchFor = (granted: string) =>
    (async () => json({ refresh_token: "refresh-xyz", scope: granted })) as typeof fetch;

  async function authorise(dir: string, scopes: string[] | undefined, granted: string) {
    let requested = "";
    await runAuthFlow({
      client: { clientId: "id", clientSecret: "s" },
      tokenPath: path.join(dir, "token.json"),
      fetchFn: fetchFor(granted),
      ...(scopes && { scopes }),
      onAuthUrl: (url) => {
        const p = new URL(url).searchParams;
        requested = p.get("scope")!;
        void fetch(`${new URL(p.get("redirect_uri")!).origin}/?code=c&state=${p.get("state")}`);
      },
    });
    return requested;
  }

  it("asks for Gmail only by default", async () => {
    await withTemp(async (dir) => {
      assert.equal(await authorise(dir, undefined, GMAIL_SCOPE), GMAIL_SCOPE);
      assert.equal(await hasScope(path.join(dir, "token.json"), DRIVE_SCOPE), false);
    });
  });

  it("asks for Gmail and Drive together when both are wanted", async () => {
    await withTemp(async (dir) => {
      const requested = await authorise(dir, [GMAIL_SCOPE, DRIVE_SCOPE], `${GMAIL_SCOPE} ${DRIVE_SCOPE}`);
      assert.deepEqual(requested.split(" ").sort(), [DRIVE_SCOPE, GMAIL_SCOPE].sort());
      const token = await loadToken(path.join(dir, "token.json"));
      assert.equal(token?.scope, `${GMAIL_SCOPE} ${DRIVE_SCOPE}`);
      assert.equal(await hasScope(path.join(dir, "token.json"), DRIVE_SCOPE), true);
    });
  });

  it("refuses to save a token when a requested scope was not granted", async () => {
    await withTemp(async (dir) => {
      await assert.rejects(authorise(dir, [GMAIL_SCOPE, DRIVE_SCOPE], GMAIL_SCOPE), /not granted: drive\.readonly/);
      assert.equal(await loadToken(path.join(dir, "token.json")), null);
    });
  });

  it("tells you how to add a missing grant before any API call is made", async () => {
    await withTemp(async (dir) => {
      const tokenPath = path.join(dir, "token.json");
      await saveToken(tokenPath, { refreshToken: "r", scope: GMAIL_SCOPE, savedAt: "now" });
      await requireScope(tokenPath, GMAIL_SCOPE, "Gmail", "--google-credentials <file>");
      await assert.rejects(requireScope(tokenPath, DRIVE_SCOPE, "Google Drive", "--google-credentials <file> --scopes gmail,drive"), /Google Drive access has not been authorised.*--scopes gmail,drive/);
    });
  });
});
