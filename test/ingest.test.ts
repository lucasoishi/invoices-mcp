import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PARSERS, describeSupport, supportedBanks } from "../src/banks/index.ts";
import { UnsupportedFormatError, formatOf, ingest } from "../src/ingest.ts";
import { ITAU_PAGE_1, ITAU_PAGE_2 } from "./helpers/itau-fixture.ts";
import { makePdf } from "./helpers/pdf.ts";

const NUBANK = "date,title,amount\n2026-08-13,Loja,\"69,99\"\n";
const ITAU_PDF = () => makePdf([ITAU_PAGE_1, ITAU_PAGE_2]);

describe("bank registry", () => {
  it("has exactly the two banks that are supported today", () => {
    assert.deepEqual(
      supportedBanks().map((b) => [b.id, b.name, b.formats]),
      [
        ["nubank", "Nubank", ["csv"]],
        ["itau", "Itaú", ["pdf"]],
      ],
    );
    assert.equal(describeSupport(), "Nubank (CSV), Itaú (PDF)");
  });

  it("gives every parser a unique id and a description", () => {
    assert.equal(new Set(PARSERS.map((p) => p.id)).size, PARSERS.length);
    for (const p of PARSERS) assert.ok(p.description.length > 20, `${p.id} needs a description`);
  });

  it("never lets two parsers claim the same file", async () => {
    const files: [string, Buffer][] = [
      ["a.csv", Buffer.from(NUBANK)],
      ["b.csv", Buffer.from("Data,Valor,Identificador,Descrição\n05/09/2026,-1.00,id,x\n")],
      ["c.pdf", ITAU_PDF()],
    ];
    for (const [name, bytes] of files) {
      const { parser } = await ingest(name, bytes);
      const format = formatOf(name)!;
      const text = format === "pdf" ? "" : bytes.toString("utf8");
      if (format === "csv") {
        const claimants = PARSERS.filter((p) => p.formats.includes(format) && p.detect({ fileName: name, format, text }));
        assert.equal(claimants.length, 1, `${name} was claimed by ${claimants.map((c) => c.id).join(" and ")}`);
      }
      assert.ok(parser.formats.includes(format));
    }
  });
});

describe("ingest", () => {
  it("picks the parser from the file's content, not just its name", async () => {
    assert.equal((await ingest("whatever.csv", Buffer.from(NUBANK))).parser.id, "nubank");
    assert.equal((await ingest("whatever.pdf", ITAU_PDF())).parser.id, "itau");
    assert.equal((await ingest("Fatura_Itau_20261019-003615.pdf", ITAU_PDF())).result.transactions.length, 12);
  });

  it("does not mistake an Itaú PDF renamed to .csv, or a CSV renamed to .pdf", async () => {
    await assert.rejects(ingest("fatura.csv", ITAU_PDF()), UnsupportedFormatError);
    await assert.rejects(ingest("export.pdf", Buffer.from(NUBANK)), /could not be read as a PDF/);
  });

  it("explains what is supported when it does not recognise a file", async () => {
    await assert.rejects(ingest("x.csv", Buffer.from("foo,bar\n1,2\n")), (e: Error) => {
      assert.ok(e instanceof UnsupportedFormatError);
      assert.match(e.message, /Supported: Nubank \(CSV\), Itaú \(PDF\)/);
      return true;
    });
    await assert.rejects(ingest("statement.pdf", makePdf([["Extrato de outro banco", "01/09 COMPRA 10,00"]])), UnsupportedFormatError);
  });

  it("refuses anything that is not a CSV or a PDF", async () => {
    await assert.rejects(ingest("notes.txt", Buffer.from("hello")), /Only \.csv and \.pdf/);
    await assert.rejects(ingest("sheet.xlsx", Buffer.from("x")), UnsupportedFormatError);
  });

  it("treats the extension case-insensitively", async () => {
    assert.equal((await ingest("EXPORT.CSV", Buffer.from(NUBANK))).parser.id, "nubank");
    assert.equal((await ingest("FATURA.PDF", ITAU_PDF())).parser.id, "itau");
  });
});
