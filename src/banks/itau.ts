/**
 * Itaú credit-card statements (PDF "Fatura").
 *
 * The statement is read from its extracted text, flattened to one line, because column order and
 * line breaks vary between PDF text extractors. What the parser relies on:
 *
 *   Vencimento: DD/MM/YYYY                              due date (rows only print DD/MM, so the year comes from here)
 *   Pagamentos efetuados DATA VALOR EM R$ ...           payments, negative amounts
 *   Lançamentos: compras e saques ... DATA ESTABELECIMENTO VALOR EM R$
 *       DD/MM MERCHANT [NN/NN] 123,45  category CITY    purchases; [NN/NN] is an installment
 *   Lançamentos no cartão 1.234,56                      per-card subtotal
 *   Lançamentos internacionais ... Dólar de Conversão R$ 5,45
 *   Total dos lançamentos atuais 13.494,85              what the lines above must add up to
 *   Compras parceladas - próximas faturas ...           FUTURE installments: ignored, not charged on this invoice
 *
 * Every parse checks its own work: parsed lines are compared with the totals the statement prints,
 * and any difference is reported as a warning rather than being silently accepted.
 * Card numbers, cardholder names and addresses are deliberately never read into the result.
 */
import { fold, isoDate, parseAmountToCents } from "../parse.js";
import { BankFormatError, type BankParser, type ParsedTransaction, type ParseResult, type ParserInput } from "../types.js";

const MONEY = String.raw`-?\d+(?:\.\d{3})*,\d{2}`;
const ROW = new RegExp(String.raw`(?<![\d/])(\d{2})\/(\d{2})\s+(?!${MONEY}(?![\d.,]))(.+?)\s+(?:(\d{2})\/(\d{2})\s+)?(${MONEY})(?![\d.,])`, "gu");
const MONEY_TOKEN = new RegExp(String.raw`(?<![\d.,])(${MONEY})(?![\d.,])`, "gu");

/**
 * Some Itaú PDFs carry a text layer with stray spaces inside words and numbers ("6.634 ,53", "128,5 0",
 * "04/ 08"). Section markers are matched with optional whitespace between characters, and number-shaped
 * damage is repaired before rows are read. Merchant names cannot be repaired and stay as printed.
 */
function loose(marker: string, flags = "u"): RegExp {
  const body = [...marker.replace(/\s+/gu, "")].map((c) => c.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(String.raw`\s*`);
  return new RegExp(body, flags);
}

function repairNumbers(flat: string): string {
  return flat
    .replace(/(\d) ?\/ ?(\d)/gu, "$1/$2") // dates: "04/ 08"
    .replace(/(\d) ?, ?(\d)/gu, "$1,$2") // decimal comma: "6.634 ,53", "50, 02"
    .replace(/,(\d) (\d)(?=\d{2}\/\d{2})/gu, ",$1$2 ") // split cents glued to the next date: "6,4 012/07"
    .replace(/,(\d) (\d)(?!\d)/gu, ",$1$2") // split cents: "128,5 0"
    .replace(/(?<![\d/])(\d{1,3}(?:\.\d{3})*\.\d{1,2}) (\d{1,2})(?=\d*,\d{2})/gu, "$1$2") // split thousands group: "3.7 91,65"
    .replace(/(,\d{2})(\d{2}\/\d{2})/gu, "$1 $2") // an amount glued to the next row's date: "103,0016/08"
    .replace(/(?<![\d/.,])(\d{1,2}) (\d{1,2}),(\d{2})(?!\d)/gu, "$1$2,$3"); // split integer part: "14 6,61"
}

const CATEGORY_ALIASES: Record<string, string> = {
  health: "saúde",
  supermarket: "supermercado",
  eletronics: "eletrônicos",
  electronics: "eletrônicos",
};

interface Due {
  iso: string;
  year: number;
  month: number;
}

/** Rows print only DD/MM. A purchase cannot come after its own due date, so a later month means last year. */
function resolveDate(day: string, month: string, due: Due): string | null {
  const m = Number(month);
  return isoDate(m > due.month ? due.year - 1 : due.year, m, Number(day));
}

function sectionBetween(flat: string, start: number, ends: number[]): string {
  if (start < 0) return "";
  const end = Math.min(...ends.filter((e) => e > start), flat.length);
  return flat.slice(start, end);
}

function parseTail(tail: string): { category: string; location: string | null } {
  const words = tail.trim().split(/\s+/).filter(Boolean);
  // PDF page furniture ("1", "L", "P") can trail a row; a lone digit or letter is never a place name.
  while (words.length > 0 && /^(\d|\p{L})$/u.test(words[words.length - 1]!)) words.pop();
  const first = words[0];
  if (first && /^\p{L}{3,}$/u.test(first)) {
    const lower = first.toLocaleLowerCase("pt-BR");
    return { category: CATEGORY_ALIASES[fold(lower)] ?? lower, location: words.slice(1).join(" ") || null };
  }
  return { category: "uncategorized", location: words.join(" ") || null };
}

const brl = (cents: number): string => (cents / 100).toFixed(2);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function parse(input: ParserInput): ParseResult {
  const flat = repairNumbers(input.text.replace(/ /g, " ").replace(/\s+/g, " ").trim());

  const dueMatch = /Vencimento:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(flat);
  const dueIso = dueMatch ? isoDate(Number(dueMatch[3]), Number(dueMatch[2]), Number(dueMatch[1])) : null;
  if (!dueMatch || !dueIso) throw new BankFormatError("Could not find the due date (Vencimento) in this Itaú statement.");
  const due: Due = { iso: dueIso, year: Number(dueMatch[3]), month: Number(dueMatch[2]) };

  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];

  const idx = (re: RegExp): number => flat.search(re);
  const purchasesStart = idx(loose("Lançamentos: compras e saques"));
  const intlStart = idx(loose("Lançamentos internacionais"));
  const totalCurrentIdx = idx(loose("Total dos lançamentos atuais"));
  const futureIdx = idx(loose("Compras parceladas - próximas faturas"));
  const intlTotalIdx = idx(loose("Total transações inter."));
  const paymentsStart = idx(loose("Pagamentos efetuados DATA VALOR EM R$"));
  const paymentsEnd = idx(loose("Total dos pagamentos"));
  if (totalCurrentIdx < 0 || (purchasesStart < 0 && intlStart < 0)) {
    throw new BankFormatError("This does not look like a readable Itaú statement: the purchases section or the statement total was not found.");
  }

  // ---- payments: negative amounts, money coming in ----
  if (paymentsStart >= 0) {
    const text = flat.slice(paymentsStart, paymentsEnd > paymentsStart ? paymentsEnd : undefined).replace(new RegExp(`^.*?${loose("VALOR EM R$").source}`, "u"), " ");
    for (const m of text.matchAll(ROW)) {
      const date = resolveDate(m[1]!, m[2]!, due);
      const cents = parseAmountToCents(m[6]!);
      if (!date || cents === null) continue;
      if (cents >= 0) continue; // a payments row is money in; a positive figure is a neighbouring purchase column
      const description = m[3]!.trim();
      transactions.push({
        date,
        description,
        merchant: description,
        category: "payment",
        amountCents: cents < 0 ? cents : -cents, // a payment is always money in
        kind: "card",
        installment: null,
        location: null,
        foreign: null,
      });
    }
  }

  // ---- purchases ----
  const subtotals: number[] = [];
  // When the text layer is damaged the two columns interleave, so purchases keep going after the international
  // header; read to the end of the text and drop international rows by value afterwards.
  const damaged = !/Total dos lançamentos atuais/u.test(flat);
  const purchaseEnds = damaged ? [] : [intlStart, totalCurrentIdx, futureIdx];
  const purchasesText = sectionBetween(flat, purchasesStart, purchaseEnds)
    .replace(loose("continua...", "giu"), " ")
    // The header line carries the cardholder's name between the two markers; drop all of it (but never more than a line's worth).
    .replace(new RegExp(`${loose("Lançamentos: compras e saques").source}.{0,80}?${loose("DATA ESTABELECIMENTO VALOR EM R$").source}`, "gu"), " ")
    .replace(loose("Lançamentos: compras e saques", "gu"), " ")
    .replace(loose("DATA ESTABELECIMENTO VALOR EM R$", "gu"), " ")
    .replace(new RegExp(`${loose("Lançamentos no cartão").source}\\s*(${MONEY})`, "gu"), (_all, amount: string) => {
      const cents = parseAmountToCents(amount);
      if (cents !== null) subtotals.push(cents);
      return " ";
    });

  // In two-column layouts a payment can sit on the same line as a purchase; payments are read from their own section.
  const paymentLike = loose("PAGAMENTO");
  const rows = [...purchasesText.matchAll(ROW)].filter((m) => !(m[6]!.startsWith("-") && paymentLike.test(m[3]!)));
  const purchases: ParsedTransaction[] = [];
  rows.forEach((m, i) => {
    const date = resolveDate(m[1]!, m[2]!, due);
    const cents = parseAmountToCents(m[6]!);
    if (!date || cents === null) {
      warnings.push("A purchase row had an unreadable date or amount and was skipped.");
      return;
    }
    const tailStart = m.index! + m[0].length;
    const tailEnd = rows[i + 1]?.index ?? purchasesText.length;
    // Interleaved columns scramble which category line belongs to which row, so a damaged text layer gets none.
    const { category, location } = damaged ? { category: "uncategorized", location: null } : parseTail(purchasesText.slice(tailStart, tailEnd));
    const description = m[3]!.trim();
    purchases.push({
      date,
      description,
      merchant: description,
      category,
      amountCents: cents,
      kind: "card",
      installment: m[4] && m[5] ? `${Number(m[4])}/${Number(m[5])}` : null,
      location,
      foreign: null,
    });
  });

  // ---- international purchases (R$ value, original amount, US$ value, conversion rate) ----
  const intl: ParsedTransaction[] = [];
  const intlAmounts: string[] = [];
  const intlText = sectionBetween(flat, intlStart, [intlTotalIdx, totalCurrentIdx, futureIdx]).replace(
    new RegExp(`${loose("Lançamentos internacionais").source}.*?${loose("DATA ESTABELECIMENTO US$ R$").source}`, "gu"),
    " ",
  );
  let previousEnd = 0;
  const rateRe = new RegExp(`${loose("Dólar de Conversão R$").source}\\s*(\\d+(?:\\.\\d{3})*,\\d+)`, "gu");
  for (const rate of intlText.matchAll(rateRe)) {
    const segment = intlText.slice(previousEnd, rate.index! + rate[0].length);
    previousEnd = rate.index! + rate[0].length;

    const rateNumber = Number(rate[1]!.replace(/\./g, "").replace(",", "."));
    let head: (string[] & { index: number }) | null = new RegExp(
      String.raw`(?<![\d/])(\d{2})\/(\d{2})\s+(.+?)\s+(?=${MONEY})`,
      "u",
    ).exec(segment);
    if (damaged) {
      // Interleaved columns put other rows in front of the international one. The right row is the one whose R$ amount
      // equals another figure after it times the printed conversion rate.
      head = null;
      for (const r of segment.matchAll(ROW)) {
        const own = parseAmountToCents(r[6]!);
        if (own === null) continue;
        const after = segment.slice(r.index! + r[0].length);
        const related = [...after.matchAll(MONEY_TOKEN)].some((a) => {
          const other = parseAmountToCents(a[1]!);
          return other !== null && Math.abs(own - Math.round(other * rateNumber)) <= Math.max(2, Math.abs(own) * 0.002);
        });
        if (related) {
          head = Object.assign([r[0].slice(0, r[0].length - r[6]!.length), r[1]!, r[2]!, r[3]!], { index: r.index! });
          break;
        }
      }
    }
    if (!head) {
      warnings.push("An international purchase could not be read and was skipped.");
      continue;
    }
    const rest = segment.slice(head.index + head[0]!.length);
    const amounts = [...rest.matchAll(MONEY_TOKEN)].map((a) => ({ text: a[1]!, cents: parseAmountToCents(a[1]!)! }));
    const currency = /\b([A-Z]{3})\b/u.exec(rest)?.[1] ?? "";
    const rateValue = Number(rate[1]!.replace(/\./g, "").replace(",", "."));

    // The R$ figure is the amount that equals another figure times the printed rate; the rest is the original amount.
    let brlIndex = 0;
    let usdIndex = -1;
    for (let i = 0; i < amounts.length && usdIndex < 0; i++) {
      for (let j = 0; j < amounts.length && usdIndex < 0; j++) {
        if (i === j) continue;
        const expected = Math.round(amounts[j]!.cents * rateValue);
        if (Math.abs(amounts[i]!.cents - expected) <= Math.max(2, Math.abs(amounts[i]!.cents) * 0.002)) {
          brlIndex = i;
          usdIndex = j;
        }
      }
    }
    if (usdIndex < 0) warnings.push("An international purchase's R$ amount could not be confirmed against its conversion rate.");

    const date = resolveDate(head[1]!, head[2]!, due);
    if (date) for (const a of amounts) intlAmounts.push(`${date}|${a.cents}`);
    const chosen = amounts[brlIndex];
    if (!date || !chosen) {
      warnings.push("An international purchase had an unreadable date or amount and was skipped.");
      continue;
    }
    // Whatever is neither the R$ figure nor the US$ figure is the amount in the original currency.
    const original = usdIndex >= 0 ? amounts.find((_, i) => i !== brlIndex && i !== usdIndex) : undefined;
    const description = head[3]!.trim();
    intl.push({
      date,
      description,
      merchant: description,
      category: "international",
      amountCents: chosen.cents,
      kind: "card",
      installment: null,
      location: null,
      foreign: original && currency ? `${original.text} ${currency}` : null,
    });
  }
  transactions.push(...intl);
  const intlKeys = new Set(intlAmounts);
  if (damaged) {
    // Interleaved columns also pull the future-installments list into this section. A future instalment shares the
    // purchase date and amount of the current one and has a higher number, so only the lowest number is charged now.
    const key = (t: ParsedTransaction): string => `${t.date}|${t.amountCents}`;
    const number = (t: ParsedTransaction): number => Number(t.installment?.split("/")[0] ?? 0);
    const lowest = new Map<string, number>();
    for (const t of purchases) if (t.installment) lowest.set(key(t), Math.min(lowest.get(key(t)) ?? Infinity, number(t)));
    const kept = purchases.filter((t) => !intlKeys.has(key(t)) && (!t.installment || number(t) === lowest.get(key(t))));
    purchases.length = 0;
    purchases.push(...kept);
  }
  transactions.push(...purchases);
  if (damaged) warnings.push("This statement's text layer is damaged (stray spaces), so merchant names may look odd and categories were not read.");

  // ---- IOF passed on for international purchases: part of the invoice total but not a purchase line ----
  const iofMatch = new RegExp(`${loose("Repasse de IOF em R$").source}\\s*(${MONEY})`, "u").exec(flat);
  const iofCents = iofMatch ? parseAmountToCents(iofMatch[1]!) : null;
  if (iofCents) {
    const lastIntlDate = intl.map((t) => t.date).sort().at(-1) ?? due.iso;
    transactions.push({
      date: lastIntlDate,
      description: "Repasse de IOF (international purchases)",
      merchant: "Repasse de IOF",
      category: "fees",
      amountCents: iofCents,
      kind: "card",
      installment: null,
      location: null,
      foreign: null,
    });
  }

  // ---- self-check against the totals the statement prints ----
  const money = (re: RegExp): number | undefined => {
    const m = re.exec(flat);
    return m ? (parseAmountToCents(m[1]!) ?? undefined) : undefined;
  };
  const statementTotal = money(new RegExp(`${loose("Total dos lançamentos atuais").source}\\s*(${MONEY})`, "u"));
  const intlStatementTotal = money(new RegExp(`${loose("Total transações inter. em R$").source}\\s*(${MONEY})`, "u"));

  if (subtotals.length > 0 && sum(subtotals) !== sum(purchases.map((t) => t.amountCents))) {
    warnings.push(
      `Purchase lines add up to R$ ${brl(sum(purchases.map((t) => t.amountCents)))} but the statement's card subtotal is R$ ${brl(sum(subtotals))}. Some lines may be missing or misread.`,
    );
  }
  if (intlStatementTotal !== undefined && intlStatementTotal !== sum(intl.map((t) => t.amountCents))) {
    warnings.push(
      `International lines add up to R$ ${brl(sum(intl.map((t) => t.amountCents)))} but the statement says R$ ${brl(intlStatementTotal)}.`,
    );
  }

  const charged = transactions.filter((t) => t.category !== "payment");
  const parsedTotal = sum(charged.map((t) => t.amountCents));
  if (statementTotal === undefined) {
    warnings.push("The statement total was not found, so the parsed lines could not be verified.");
  } else if (parsedTotal !== statementTotal) {
    warnings.push(
      `Parsed lines add up to R$ ${brl(parsedTotal)} but the statement total is R$ ${brl(statementTotal)} (difference R$ ${brl(parsedTotal - statementTotal)}). Some lines may be missing or misread.`,
    );
  }

  if (transactions.length === 0) throw new BankFormatError("No transactions were found in this Itaú statement.");

  return {
    kind: "card",
    transactions,
    warnings,
    meta: {
      dueDate: due.iso,
      month: due.iso.slice(0, 7),
      ...(statementTotal !== undefined && { statementTotalCents: statementTotal }),
      parsedTotalCents: parsedTotal,
    },
  };
}

export const itau: BankParser = {
  id: "itau",
  name: "Itaú",
  formats: ["pdf"],
  description: "PDF credit-card statements (Fatura): purchases, installments, international purchases, payments and IOF.",
  detect: (input) =>
    input.format === "pdf" && /Ita[uú]/iu.test(input.text) && /Total desta fatura/iu.test(input.text) && /Lançamentos/iu.test(input.text),
  parse,
};
