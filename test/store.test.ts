import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { InvoiceStore } from "../src/store.ts";
import { ITAU_PAGE_1, ITAU_PAGE_2 } from "./helpers/itau-fixture.ts";
import { makePdf } from "./helpers/pdf.ts";

const sampleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sample");
const CARD = "date,category,title,amount\n2026-09-01,x,Thing,10.00\n";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nubank-mcp-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("InvoiceStore", () => {
  it("loads the sample folder, sorted by month, detecting both layouts", async () => {
    const { invoices, skippedFiles } = await new InvoiceStore(sampleDir).load();
    assert.deepEqual(
      invoices.map((i) => [i.id, i.month, i.kind, i.bank]),
      [
        ["2026-08", "2026-08", "card", "nubank"],
        ["2026-09", "2026-09", "card", "nubank"],
        ["nuconta-2026-09", "2026-09", "account", "nubank"],
        ["Fatura_Itau_exemplo", "2026-10", "card", "itau"], // month comes from the statement's due date
        ["2026-10", "2026-10", "card", "nubank"],
      ],
    );
    assert.equal(skippedFiles.length, 0);
  });

  it("reads PDFs too, and says why a file from an unsupported bank was skipped", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "2026-09.csv"), CARD);
      await writeFile(path.join(dir, "itau.pdf"), makePdf([ITAU_PAGE_1, ITAU_PAGE_2]));
      await writeFile(path.join(dir, "other-bank.pdf"), makePdf([["Extrato Banco Exemplo", "01/09 COMPRA 10,00"]]));
      await writeFile(path.join(dir, "broken.pdf"), "not a pdf at all");
      const { invoices, skippedFiles } = await new InvoiceStore(dir).load();
      assert.deepEqual(invoices.map((i) => i.bank).sort(), ["itau", "nubank"]);
      const reasons = Object.fromEntries(skippedFiles.map((s) => [s.file, s.reason]));
      assert.equal(reasons["other-bank.pdf"], "No supported bank format was recognised. Supported: Nubank (CSV), Itaú (PDF).");
      assert.match(reasons["broken.pdf"]!, /could not be read as a PDF/);
    });
  });

  it("reads only top-level .csv and .pdf files", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "2026-09.csv"), CARD);
      await writeFile(path.join(dir, "notes.txt"), "not a csv");
      await mkdir(path.join(dir, "nested"));
      await writeFile(path.join(dir, "nested", "2026-01.csv"), CARD);
      const { invoices } = await new InvoiceStore(dir).load();
      assert.deepEqual(invoices.map((i) => i.id), ["2026-09"]);
    });
  });

  it("reports an unrecognised CSV without failing the rest", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "2026-09.csv"), CARD);
      await writeFile(path.join(dir, "other.csv"), "foo,bar\n1,2\n");
      const { invoices, skippedFiles } = await new InvoiceStore(dir).load();
      assert.equal(invoices.length, 1);
      assert.equal(skippedFiles[0]!.file, "other.csv");
    });
  });

  it("uses the dominant transaction month when the file name has none", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "fatura.csv"), CARD);
      const { invoices } = await new InvoiceStore(dir).load();
      assert.equal(invoices[0]!.month, "2026-09");
    });
  });

  it("skips a symlink that points outside the folder", async (t) => {
    await withTempDir(async (outside) => {
      await withTempDir(async (dir) => {
        await writeFile(path.join(outside, "secret.csv"), CARD);
        try {
          await symlink(path.join(outside, "secret.csv"), path.join(dir, "2026-09.csv"));
        } catch {
          t.skip("symlinks are not permitted in this environment");
          return;
        }
        const { invoices, skippedFiles } = await new InvoiceStore(dir).load();
        assert.equal(invoices.length, 0);
        assert.match(skippedFiles[0]!.reason, /outside the folder/);
      });
    });
  });

  it("picks up file changes (cache is keyed by mtime and size)", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "2026-09.csv");
      await writeFile(file, CARD);
      const store = new InvoiceStore(dir);
      assert.equal((await store.load()).invoices[0]!.transactions.length, 1);
      await writeFile(file, CARD + "2026-09-02,x,Other,5.00\n");
      assert.equal((await store.load()).invoices[0]!.transactions.length, 2);
    });
  });

  it("throws when the folder does not exist", async () => {
    await assert.rejects(new InvoiceStore(path.join(sampleDir, "missing")).load());
  });
});
