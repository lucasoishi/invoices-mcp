import { fold as norm, merchantKey } from "./parse.js";
import type { BankId, Transaction } from "./types.js";

/** Cents -> BRL as a plain number (cents are integers, so this is exact to 2 decimals). */
export const brl = (cents: number): number => Math.round(cents) / 100;

/**
 * Money moved only to settle a card bill is not spending: the card payment received on an invoice,
 * and the matching "pay the bill" outflow on an account statement. Counting them would double-count.
 */
const TRANSFER_CATEGORIES = new Set(["payment", "card-bill"]);
export const isTransfer = (t: Transaction): boolean => TRANSFER_CATEGORIES.has(t.category);

/**
 * spend    = purchases and fees (money out, before refunds)
 * refunds  = cancellations and refunds (money back)
 * payments = card-bill settlements (never spending)
 * netSpend = spend - refunds: what you actually spent
 */
export function totals(transactions: Transaction[]) {
  let spend = 0;
  let refunds = 0;
  let payments = 0;
  for (const t of transactions) {
    if (isTransfer(t)) payments += Math.abs(t.amountCents);
    else if (t.amountCents > 0) spend += t.amountCents;
    else refunds += -t.amountCents;
  }
  return {
    spendBRL: brl(spend),
    refundsBRL: brl(refunds),
    paymentsBRL: brl(payments),
    netSpendBRL: brl(spend - refunds),
  };
}

export interface Filter {
  from?: string;
  to?: string;
  query?: string;
  category?: string;
  invoice?: string;
  bank?: BankId;
  /** Compared against the absolute amount, in cents */
  minCents?: number;
  maxCents?: number;
}

export function applyFilter(transactions: Transaction[], f: Filter): Transaction[] {
  const query = f.query ? norm(f.query) : null;
  const category = f.category ? norm(f.category) : null;
  return transactions.filter((t) => {
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (f.invoice && t.invoice !== f.invoice) return false;
    if (f.bank && t.bank !== f.bank) return false;
    if (category && norm(t.category) !== category) return false;
    if (query && !norm(t.description).includes(query)) return false;
    const abs = Math.abs(t.amountCents);
    if (f.minCents !== undefined && abs < f.minCents) return false;
    if (f.maxCents !== undefined && abs > f.maxCents) return false;
    return true;
  });
}

export interface PublicTransaction {
  bank: BankId;
  date: string;
  description: string;
  category: string;
  amountBRL: number;
  installment: string | null;
  location: string | null;
  foreign: string | null;
  invoice: string;
}

export const toPublic = (t: Transaction): PublicTransaction => ({
  bank: t.bank,
  date: t.date,
  description: t.description,
  category: t.category,
  amountBRL: brl(t.amountCents),
  installment: t.installment,
  location: t.location,
  foreign: t.foreign,
  invoice: t.invoice,
});

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export function summarize(transactions: Transaction[], topN = 10) {
  const real = transactions.filter((t) => !isTransfer(t));
  const overall = totals(transactions);
  const netCents = Math.round(overall.netSpendBRL * 100);

  // Categories and merchants are net of refunds, so a cancelled booking nets to zero.
  const byCategory = new Map<string, { cents: number; count: number }>();
  const byMerchant = new Map<string, { merchant: string; cents: number; count: number }>();
  for (const t of real) {
    const c = byCategory.get(t.category) ?? { cents: 0, count: 0 };
    c.cents += t.amountCents;
    c.count++;
    byCategory.set(t.category, c);

    const key = merchantKey(t.merchant);
    const m = byMerchant.get(key) ?? { merchant: t.merchant, cents: 0, count: 0 };
    m.cents += t.amountCents;
    m.count++;
    byMerchant.set(key, m);
  }

  const byBank = new Map<BankId, Transaction[]>();
  for (const t of transactions) byBank.set(t.bank, [...(byBank.get(t.bank) ?? []), t]);

  const dates = transactions.map((t) => t.date).sort();
  return {
    transactionCount: transactions.length,
    dateRange: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    ...overall,
    note:
      "spend = purchases and fees; refunds = cancellations and money back; payments = card-bill settlements (not spending); " +
      "netSpend = spend - refunds. Categories and merchants are net of refunds.",
    byBank: [...byBank.entries()]
      .map(([bank, list]) => ({ bank, ...totals(list), transactionCount: list.length }))
      .sort((a, b) => b.netSpendBRL - a.netSpendBRL),
    byCategory: [...byCategory.entries()]
      .filter(([, v]) => v.cents !== 0)
      .map(([category, v]) => ({
        category,
        netSpendBRL: brl(v.cents),
        count: v.count,
        sharePercent: netCents > 0 ? Math.round((v.cents / netCents) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.netSpendBRL - a.netSpendBRL),
    topMerchants: [...byMerchant.values()]
      .filter((m) => m.cents > 0)
      .map((m) => ({ merchant: m.merchant, netSpendBRL: brl(m.cents), count: m.count }))
      .sort((a, b) => b.netSpendBRL - a.netSpendBRL)
      .slice(0, topN),
    largestPurchases: real
      .filter((t) => t.amountCents > 0)
      .sort((a, b) => b.amountCents - a.amountCents)
      .slice(0, 5)
      .map(toPublic),
  };
}

export function monthlyTotals(transactions: Transaction[]) {
  const months = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const key = t.date.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), t]);
  }
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, list]) => ({ month, ...totals(list), transactionCount: list.length }));
}

export function compareMonths(transactions: Transaction[], a: string, b: string) {
  const netByCategory = (month: string) => {
    const map = new Map<string, number>();
    for (const t of transactions) {
      if (!isTransfer(t) && t.date.startsWith(month)) {
        map.set(t.category, (map.get(t.category) ?? 0) + t.amountCents);
      }
    }
    return map;
  };
  const ma = netByCategory(a);
  const mb = netByCategory(b);
  const categories = new Set([...ma.keys(), ...mb.keys()]);
  const rows = [...categories].map((category) => {
    const ca = ma.get(category) ?? 0;
    const cb = mb.get(category) ?? 0;
    return {
      category,
      [a]: brl(ca),
      [b]: brl(cb),
      changeBRL: brl(cb - ca),
      changePercent: ca === 0 ? null : Math.round(((cb - ca) / ca) * 1000) / 10,
    };
  });
  rows.sort((x, y) => Math.abs(y.changeBRL) - Math.abs(x.changeBRL));
  const ta = sum([...ma.values()]);
  const tb = sum([...mb.values()]);
  return {
    months: { from: a, to: b },
    totalNetSpendBRL: { [a]: brl(ta), [b]: brl(tb) },
    totalChangeBRL: brl(tb - ta),
    totalChangePercent: ta === 0 ? null : Math.round(((tb - ta) / ta) * 1000) / 10,
    byCategory: rows,
  };
}

/**
 * Likely subscriptions: the same merchant charged a similar amount (within 5% of the
 * median), about once a month, in at least `minMonths` different months. Installment
 * purchases are ignored, and merchants charged several times a month (a café, a petrol
 * station) are not subscriptions, so they are left out.
 */
export function findRecurring(transactions: Transaction[], minMonths = 3) {
  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (isTransfer(t) || t.amountCents <= 0 || t.installment) continue;
    const key = merchantKey(t.merchant);
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const results: {
    merchant: string;
    typicalAmountBRL: number;
    monthsSeen: number;
    lastSeen: string;
    estimatedYearlyBRL: number;
  }[] = [];

  for (const list of groups.values()) {
    const sorted = list.map((t) => t.amountCents).sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const similar = list.filter((t) => Math.abs(t.amountCents - median) <= median * 0.05);
    const months = new Set(similar.map((t) => t.date.slice(0, 7)));
    if (months.size < minMonths || similar.length > months.size + 1) continue;
    const last = similar.map((t) => t.date).sort().at(-1)!;
    results.push({
      merchant: similar[0]!.merchant,
      typicalAmountBRL: brl(median),
      monthsSeen: months.size,
      lastSeen: last,
      estimatedYearlyBRL: brl(median * 12),
    });
  }
  return results.sort((a, b) => b.typicalAmountBRL - a.typicalAmountBRL);
}
