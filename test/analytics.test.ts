import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyFilter, compareMonths, findRecurring, monthlyTotals, summarize } from "../src/analytics.ts";
import type { Transaction } from "../src/parse.ts";
import { InvoiceStore } from "../src/store.ts";

const sampleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sample");

let all: Transaction[] = [];
before(async () => {
  const { invoices } = await new InvoiceStore(sampleDir).load();
  all = invoices.filter((i) => i.bank === "nubank" && i.kind === "card").flatMap((i) => i.transactions);
});

describe("summarize", () => {
  it("separates spend from credits (totals checked against an independent sum of the CSVs)", () => {
    const aug = summarize(applyFilter(all, { invoice: "2026-08" }));
    assert.equal(aug.spendBRL, 1039.34);
    assert.equal(aug.paymentsBRL, 1000); // the card payment: settles the bill, is not spending
    assert.equal(aug.refundsBRL, 0);
    assert.equal(aug.netSpendBRL, 1039.34);

    const sep = summarize(applyFilter(all, { invoice: "2026-09" }));
    assert.equal(sep.spendBRL, 970.47);
    assert.equal(sep.paymentsBRL, 1100);
    assert.equal(sep.refundsBRL, 20); // the pharmacy refund
    assert.equal(sep.netSpendBRL, 950.47); // 970.47 - 20.00
  });

  it("ranks categories and merchants", () => {
    const s = summarize(applyFilter(all, { invoice: "2026-10" }));
    assert.equal(s.byCategory[0]!.category, "supermercado");
    assert.equal(s.topMerchants[0]!.merchant, "Mercado do Bairro");
    const share = s.byCategory.reduce((a, c) => a + c.sharePercent, 0);
    assert.ok(Math.abs(share - 100) < 0.5);
  });

  it("handles an empty selection", () => {
    const s = summarize([]);
    assert.equal(s.spendBRL, 0);
    assert.equal(s.dateRange, null);
  });
});

describe("applyFilter", () => {
  it("matches text ignoring case and accents", () => {
    assert.equal(applyFilter(all, { query: "CAFE DA esquina" }).length, 5);
    assert.equal(applyFilter(all, { query: "farmácia" }).length, 2);
  });
  it("filters by absolute amount and date range", () => {
    const big = applyFilter(all, { minCents: 18000 });
    assert.ok(big.every((t) => Math.abs(t.amountCents) >= 18000));
    const sept = applyFilter(all, { from: "2026-09-01", to: "2026-09-30" });
    assert.ok(sept.every((t) => t.date.startsWith("2026-09")));
  });
  it("filters by category", () => {
    assert.ok(applyFilter(all, { category: "Saúde" }).every((t) => t.category === "saúde"));
  });
});

describe("monthlyTotals / compareMonths", () => {
  it("groups by transaction month", () => {
    const months = monthlyTotals(all).map((m) => m.month);
    assert.deepEqual(months, ["2026-08", "2026-09", "2026-10"]);
  });
  it("shows the biggest category changes first", () => {
    const diff = compareMonths(all, "2026-09", "2026-10");
    assert.equal(diff.totalChangeBRL, Math.round((848.62 - 950.47) * 100) / 100); // September net of its R$ 20 refund
    assert.ok(Math.abs(diff.byCategory[0]!.changeBRL) >= Math.abs(diff.byCategory.at(-1)!.changeBRL));
  });
});

describe("findRecurring", () => {
  it("finds the monthly subscriptions and nothing else", () => {
    const found = findRecurring(all, 3).map((r) => r.merchant).sort();
    assert.deepEqual(found, ["Academia Forma", "Cloud Armazenamento", "Streaming Plus"]);
  });
  it("ignores installments, frequent small purchases and varying amounts", () => {
    const found = findRecurring(all, 3).map((r) => r.merchant);
    for (const not of ["Eletro Casa", "Cafe da Esquina", "Mercado do Bairro", "Posto Rota 66"]) {
      assert.ok(!found.includes(not), `${not} should not be flagged`);
    }
  });
  it("reports a typical amount and yearly estimate", () => {
    const streaming = findRecurring(all, 3).find((r) => r.merchant === "Streaming Plus")!;
    assert.equal(streaming.typicalAmountBRL, 39.9);
    assert.equal(streaming.estimatedYearlyBRL, 478.8);
    assert.equal(streaming.monthsSeen, 3);
  });
});

describe("multi-bank totals (fake Itaú statement)", () => {
  let itauTx: Transaction[] = [];
  before(async () => {
    const { invoices } = await new InvoiceStore(sampleDir).load();
    itauTx = invoices.filter((i) => i.bank === "itau").flatMap((i) => i.transactions);
  });

  it("a cancelled purchase nets out instead of counting as spending", () => {
    const s = summarize(itauTx);
    assert.equal(s.spendBRL, 3500.7); // purchases, fees and the R$ 1.850 booking, before the cancellation
    assert.equal(s.refundsBRL, 1850);
    assert.equal(s.netSpendBRL, 1650.7); // = the statement total
    assert.equal(s.paymentsBRL, 1000); // last month's bill: not spending
    const hotel = s.byCategory.find((c) => c.category === "hotel");
    assert.equal(hotel?.netSpendBRL, 507.34); // the booking and its cancellation cancel out, the installment remains
  });

  it("keeps banks apart and together", () => {
    const both = summarize([...all, ...itauTx]);
    assert.deepEqual(both.byBank.map((b) => b.bank).sort(), ["itau", "nubank"]);
    assert.equal(applyFilter([...all, ...itauTx], { bank: "itau" }).length, itauTx.length);
    assert.ok(applyFilter([...all, ...itauTx], { bank: "nubank" }).every((x) => x.bank === "nubank"));
  });

  it("does not count an account-statement card-bill payment as spending", async () => {
    const { invoices } = await new InvoiceStore(sampleDir).load();
    const account = invoices.find((i) => i.kind === "account")!;
    const bill = account.transactions.find((x) => /fatura/i.test(x.description))!;
    assert.equal(bill.category, "card-bill");
    const s = summarize(account.transactions);
    assert.equal(s.paymentsBRL, 300);
    assert.equal(s.spendBRL, 1245.9); // R$ 1.200 rent + R$ 45,90 debit purchase
  });
});
