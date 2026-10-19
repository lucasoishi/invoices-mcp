import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { itau } from "../src/banks/itau.ts";
import { extractPdfText } from "../src/pdf.ts";
import { BankFormatError, type ParserInput } from "../src/types.ts";
import { ITAU_PAGE_1, ITAU_PAGE_2, itauLines, itauText } from "./helpers/itau-fixture.ts";
import { makePdf } from "./helpers/pdf.ts";

const pdf = (text: string): ParserInput => ({ fileName: "Fatura.pdf", format: "pdf", text });
const parsed = () => itau.parse(pdf(itauText()));

describe("Itaú parser (fake statement)", () => {
  it("finds every line: payment, purchases, international purchases and IOF", () => {
    const { transactions, kind } = parsed();
    assert.equal(kind, "card");
    assert.equal(transactions.length, 12); // 1 payment + 8 purchases + 2 international + 1 IOF
  });

  it("adds up exactly to the totals printed on the statement, with no warnings", () => {
    const { warnings, meta, transactions } = parsed();
    assert.deepEqual(warnings, []);
    assert.equal(meta.statementTotalCents, 165070);
    assert.equal(meta.parsedTotalCents, 165070);
    // independent sum: everything except the payment
    assert.equal(
      transactions.filter((t) => t.category !== "payment").reduce((a, t) => a + t.amountCents, 0),
      165070,
    );
  });

  it("takes the due date from the statement and the year of each row from it", () => {
    const { meta, transactions } = parsed();
    assert.equal(meta.dueDate, "2026-10-01");
    assert.equal(meta.month, "2026-10");
    const byName = Object.fromEntries(transactions.map((t) => [t.description, t.date]));
    assert.equal(byName["LOJA UM"], "2026-05-20"); // bought in May, billed in October
    assert.equal(byName["MERCADO EXEMPLO"], "2026-09-05");
  });

  it("rolls the year back for December purchases on a January statement", () => {
    const text = [
      "Vencimento: 05/01/2027",
      "Total desta fatura 10,00",
      "Itaú",
      "Lançamentos: compras e saques X",
      "DATA ESTABELECIMENTO VALOR EM R$",
      "28/12 LOJA 10,00",
      "outros CIDADE",
      "Total dos lançamentos atuais 10,00",
    ].join("\n");
    const { transactions, warnings } = itau.parse(pdf(text));
    assert.equal(transactions[0]!.date, "2026-12-28");
    assert.deepEqual(warnings, []);
  });

  it("reads installments and ignores the 'future installments' section", () => {
    const { transactions } = parsed();
    assert.equal(transactions.find((t) => t.description === "LOJA UM")!.installment, "5/6");
    assert.equal(transactions.find((t) => t.description === "LOJA DOIS")!.installment, "1/3");
    assert.ok(!transactions.some((t) => t.installment === "6/6" || t.installment === "2/3"), "future installments must not be counted");
  });

  it("treats a cancellation as money back and the payment as a credit", () => {
    const { transactions } = parsed();
    assert.equal(transactions.find((t) => t.description === "CANCELAMENTO DE COMPRA")!.amountCents, -185000);
    const payment = transactions.find((t) => t.category === "payment")!;
    assert.equal(payment.amountCents, -100000);
    assert.equal(payment.date, "2026-09-01");
  });

  it("reads the category and place printed under each purchase, including English labels", () => {
    const { transactions } = parsed();
    const cafe = transactions.find((t) => t.description === "CAFE EXEMPLO")!;
    assert.deepEqual([cafe.category, cafe.location], ["restaurante", "CIDADE DOIS"]);
    assert.equal(transactions.find((t) => t.description === "FARMACIA EXEMPLO")!.category, "saúde"); // HEALTH
    assert.equal(transactions.find((t) => t.description === "MERCADO EXEMPLO")!.category, "supermercado"); // SUPERMARKET
  });

  it("is not thrown off by the page break, the repeated header or a stray page number", () => {
    const { transactions } = parsed();
    const hotel = transactions.filter((t) => t.description === "HOTEL EXEMPLO");
    assert.equal(hotel.length, 1);
    assert.equal(hotel[0]!.location, "CIDADE TRES"); // the stray "1" before the next page is not part of the place
    assert.ok(!transactions.some((t) => /continua|DATA ESTABELECIMENTO/i.test(t.description)));
  });

  it("works out which figure is R$ on international purchases from the conversion rate", () => {
    const { transactions } = parsed();
    const one = transactions.find((t) => t.description === "SERVICO EXTERIOR UM")!;
    const two = transactions.find((t) => t.description === "SERVICO EXTERIOR DOIS")!;
    assert.equal(one.amountCents, 6714);
    assert.equal(one.foreign, "8,99 GBP");
    assert.equal(two.amountCents, 68867);
    assert.equal(two.foreign, "651,94 BRL");
    assert.equal(one.category, "international");
  });

  it("records the IOF passed on for international purchases as a fee", () => {
    const iof = parsed().transactions.find((t) => t.category === "fees")!;
    assert.equal(iof.amountCents, 3054);
  });

  it("warns, rather than silently accepting, when the lines do not add up", () => {
    const tampered = itauText().replace("Total dos lançamentos atuais 1.650,70", "Total dos lançamentos atuais 1.700,70");
    const { warnings, meta } = itau.parse(pdf(tampered));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /statement total is R\$ 1700\.70/);
    assert.notEqual(meta.parsedTotalCents, meta.statementTotalCents);
  });

  it("warns when a purchase line goes missing", () => {
    const missing = itauText().replace("26/08 CAFE EXEMPLO 14,00\nrestaurante CIDADE DOIS\n", "");
    const { warnings, transactions } = itau.parse(pdf(missing));
    assert.equal(transactions.length, 11);
    assert.ok(warnings.some((w) => /subtotal|statement total/.test(w)));
  });

  it("is indifferent to how the extractor breaks lines", () => {
    const oneLine = itau.parse(pdf(itauLines().join(" ")));
    const spaced = itau.parse(pdf(itauLines().join("\n\n")));
    const reference = parsed();
    assert.deepEqual(oneLine.transactions, reference.transactions);
    assert.deepEqual(spaced.transactions, reference.transactions);
  });

  it("never copies the cardholder name or card number into the result", () => {
    const json = JSON.stringify(parsed());
    assert.ok(!json.includes("TITULAR"), "cardholder name leaked");
    assert.ok(!/\d{4}\.XXXX/.test(json), "card number leaked");
  });

  it("detects Itaú PDFs and nothing else", () => {
    assert.equal(itau.detect(pdf(itauText())), true);
    assert.equal(itau.detect(pdf("Some other bank statement Total desta fatura Lançamentos")), false);
    assert.equal(itau.detect({ fileName: "x.csv", format: "csv", text: itauText() }), false);
  });

  it("refuses a statement with no due date", () => {
    assert.throws(() => itau.parse(pdf(itauText().replace("Vencimento:", "Venc."))), BankFormatError);
  });

  it("refuses a statement with no transactions", () => {
    assert.throws(() => itau.parse(pdf("Vencimento: 01/10/2026\nItaú Total desta fatura 0,00 Lançamentos")), BankFormatError);
  });
});

describe("Itaú statement whose text layer has stray spaces", () => {
  // Some real statements come out of the PDF as "6.634 ,53", "128,5 0", "04/ 08" and "Total dos lançamen tos atuais".
  const damage = (text: string): string =>
    text
      .replace("Total dos lançamentos atuais 1.650,70", "Total dos lançamen tos atuais 1.650,7 0")
      .replace("Total desta fatura 1.650,70", "Total desta fatura 1.650 ,70")
      .replace("Lançamentos internacionais", "Lança mentos inter nacionais")
      .replace("Compras parceladas - próximas faturas", "Com pras parce ladas - próximas fa turas")
      .replace("05/06 138,84", "05/06 138, 84")
      .replace("01/09 PAGAMENTO DEB AUTOMATIC -1.000,00", "01/ 09 PAGAM ENTO DEB AUTOMATIC -1.0 00,00")
      .replace("27/08 FARMACIA EXEMPLO 45,97", "27/08 FARMACIA EXEMPLO 4 5,97")
      .replace("04/09 LOJA DOIS 02/03 507,33", "04/09 LOJA DOIS 02/03 507,34")
      .replace("Lançamentos no cartão 864,35", "Lançamentos no cartão 864 ,35");

  it("still reconciles to the printed total, without double-counting international or future lines", () => {
    const { transactions, warnings, meta } = itau.parse(pdf(damage(itauText())));
    assert.equal(meta.statementTotalCents, 165070);
    assert.equal(meta.parsedTotalCents, 165070);
    assert.equal(transactions.filter((t) => t.category === "payment").length, 1);
    assert.equal(transactions.filter((t) => t.category === "international").length, 2);
    assert.ok(!transactions.some((t) => t.installment === "6/6" || t.installment === "2/3"), "future installments must not be counted");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /text layer is damaged/);
  });

  it("does not guess categories it cannot read reliably", () => {
    const { transactions } = itau.parse(pdf(damage(itauText())));
    assert.ok(transactions.filter((t) => t.category !== "payment" && t.category !== "international" && t.category !== "fees").every((t) => t.category === "uncategorized"));
  });

  it("refuses text that has no statement total at all instead of guessing", () => {
    const text = itauText().replace("Total dos lançamentos atuais 1.650,70", "").replace("Lançamentos: compras e saques", "").replace("Lançamentos internacionais", "");
    assert.throws(() => itau.parse(pdf(text)), BankFormatError);
  });
});

describe("Itaú statement as a real PDF file", () => {
  it("gives the same result as the plain text once the PDF is read", async () => {
    const file = makePdf([ITAU_PAGE_1, ITAU_PAGE_2]);
    const text = await extractPdfText(file);
    assert.equal(itau.detect(pdf(text)), true);
    const fromPdf = itau.parse(pdf(text));
    assert.deepEqual(fromPdf.transactions, parsed().transactions);
    assert.deepEqual(fromPdf.warnings, []);
  });

  it("reads accented text correctly", async () => {
    const text = await extractPdfText(makePdf([["Lançamentos: compras e saques", "saúde Itaú Emissão"]]));
    assert.match(text, /Lançamentos: compras e saques/);
    assert.match(text, /saúde Itaú Emissão/);
  });

  it("reports a damaged file instead of crashing", async () => {
    await assert.rejects(extractPdfText(Buffer.from("this is not a pdf")), /could not be read as a PDF/);
  });
});
