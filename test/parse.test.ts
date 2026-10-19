import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { merchantKey, parseAmountToCents, parseCsv, parseDate, splitInstallment } from "../src/parse.ts";

describe("parseAmountToCents", () => {
  const cases: [string, number | null][] = [
    ["45.90", 4590],
    ["45,90", 4590],
    ["1.234,56", 123456],
    ["1,234.56", 123456],
    ["R$ 1.234,56", 123456],
    ["-12,30", -1230],
    ["- 139,98", -13998],
    ["(12.30)", -1230],
    ["+7", 700],
    ["1.234", 123400], // pt-BR thousands separator, not 1.234 reais
    ["0,5", 50],
    ["", null],
    ["abc", null],
    ["12.345,678", null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(parseAmountToCents(input), expected);
    });
  }

  it("never produces floating point noise", () => {
    assert.equal(parseAmountToCents("0.10")! + parseAmountToCents("0.20")!, 30);
  });
});

describe("parseDate", () => {
  it("reads ISO and Brazilian dates", () => {
    assert.equal(parseDate("2026-09-05"), "2026-09-05");
    assert.equal(parseDate("05/09/2026"), "2026-09-05");
  });
  it("rejects impossible dates", () => {
    assert.equal(parseDate("2026-02-30"), null);
    assert.equal(parseDate("31/04/2026"), null);
    assert.equal(parseDate("not a date"), null);
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and a BOM", () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n', ",");
    assert.deepEqual(rows, [
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
  it("skips blank lines", () => {
    assert.equal(parseCsv("a,b\n\n1,2\n", ",").length, 2);
  });
});

describe("splitInstallment / merchantKey", () => {
  it("extracts the installment and cleans the merchant", () => {
    assert.deepEqual(splitInstallment("Eletro Casa - Parcela 2/10"), { merchant: "Eletro Casa", installment: "2/10" });
    assert.deepEqual(splitInstallment("Cafe"), { merchant: "Cafe", installment: null });
  });
  it("groups merchants regardless of case and accents", () => {
    assert.equal(merchantKey("Café  da Esquina"), merchantKey("cafe da esquina"));
  });
});
