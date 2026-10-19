import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nubank } from "../src/banks/nubank.ts";
import { BankFormatError, type ParserInput } from "../src/types.ts";

const csv = (text: string): ParserInput => ({ fileName: "x.csv", format: "csv", text });

describe("Nubank parser", () => {
  it("reads a card export: purchases are positive", () => {
    const { kind, transactions, warnings } = nubank.parse(
      csv("date,category,title,amount\n2026-09-01,restaurante,Cafe,19.00\n2026-09-02,,Pagamento recebido,-100.00\n"),
    );
    assert.equal(kind, "card");
    assert.equal(warnings.length, 0);
    assert.equal(transactions[0]!.amountCents, 1900);
    assert.equal(transactions[0]!.category, "restaurante");
    assert.equal(transactions[1]!.amountCents, -10000);
    assert.equal(transactions[1]!.category, "payment"); // settling a card bill is not spending
  });

  it("reads the card export as Nubank actually emails it: no category column, pt-BR amounts, spaced minus", () => {
    const { kind, transactions, warnings } = nubank.parse(
      csv(
        [
          "date,title,amount",
          '2026-08-13,Loja Exemplo,"69,99"',
          '2026-10-09,Streaming Exemplo,"44,90"',
          '2026-08-04,Pagamento recebido,"- 139,98"',
        ].join("\n") + "\n",
      ),
    );
    assert.equal(kind, "card");
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      transactions.map((t) => [t.date, t.amountCents, t.category]),
      [
        ["2026-08-13", 6999, "uncategorized"],
        ["2026-10-09", 4490, "uncategorized"],
        ["2026-08-04", -13998, "payment"],
      ],
    );
  });

  it("reads an account export: money out is flipped to positive", () => {
    const { kind, transactions } = nubank.parse(
      csv("Data,Valor,Identificador,Descrição\n05/09/2026,-1200.00,id-1,Aluguel\n01/09/2026,3500.00,id-2,Salário\n"),
    );
    assert.equal(kind, "account");
    assert.equal(transactions[0]!.amountCents, 120000);
    assert.equal(transactions[0]!.date, "2026-09-05");
    assert.equal(transactions[1]!.amountCents, -350000);
  });

  it("supports semicolon-delimited files with decimal commas", () => {
    const { transactions } = nubank.parse(csv('date;category;title;amount\n2026-09-01;lazer;Cinema;"64,00"\n'));
    assert.equal(transactions[0]!.amountCents, 6400);
  });

  it("skips bad rows and reports counts without leaking their contents", () => {
    const { transactions, warnings } = nubank.parse(
      csv("date,category,title,amount\nnope,x,SECRET MERCHANT,10\n2026-09-01,x,Ok,zzz\n2026-09-01,x,Fine,5.00\n"),
    );
    assert.equal(transactions.length, 1);
    assert.equal(warnings.length, 2);
    assert.ok(!warnings.join(" ").includes("SECRET"));
  });

  it("keeps the installment marker", () => {
    const { transactions } = nubank.parse(csv("date,category,title,amount\n2026-08-09,casa,Eletro Casa - Parcela 1/3,166.33\n"));
    assert.equal(transactions[0]!.installment, "1/3");
    assert.equal(transactions[0]!.merchant, "Eletro Casa");
  });

  it("detects only CSV files with a recognisable header", () => {
    assert.equal(nubank.detect(csv("date,title,amount\n")), true);
    assert.equal(nubank.detect(csv("Data,Valor,Identificador,Descrição\n")), true);
    assert.equal(nubank.detect(csv("foo,bar\n1,2\n")), false);
    assert.equal(nubank.detect(csv("")), false);
    assert.equal(nubank.detect({ fileName: "x.pdf", format: "pdf", text: "date,title,amount" }), false);
  });

  it("refuses to parse a file it does not recognise", () => {
    assert.throws(() => nubank.parse(csv("foo,bar\n1,2\n")), BankFormatError);
  });
});
