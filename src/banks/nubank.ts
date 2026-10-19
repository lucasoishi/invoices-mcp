/**
 * Nubank CSV exports.
 *
 * Two layouts are understood, detected from the header row:
 *   - Card invoice:      date,title,amount  (as e-mailed as "Extrato da fatura"; a category column is optional)
 *   - Account statement: Data,Valor,Identificador,Descrição
 *
 * Normalised so `amountCents` is positive when money leaves you (a purchase, a transfer out)
 * and negative when money comes back (a refund, a card payment, a deposit).
 */
import {
  detectDelimiter,
  fold,
  parseAmountToCents,
  parseCsv,
  parseDate,
  splitInstallment,
} from "../parse.js";
import { BankFormatError, type BankParser, type Kind, type ParsedTransaction, type ParseResult, type ParserInput } from "../types.js";

const HEADERS = {
  date: ["date", "data"],
  amount: ["amount", "valor"],
  description: ["title", "titulo", "description", "descricao", "detalhes"],
  category: ["category", "categoria"],
  id: ["identificador", "id"],
} as const;

const findColumn = (header: string[], names: readonly string[]): number => header.findIndex((h) => names.includes(fold(h)));

interface Columns {
  date: number;
  amount: number;
  description: number;
  category: number;
  id: number;
  kind: Kind;
}

function readHeader(text: string): { columns: Columns; rows: string[][] } | null {
  const rows = parseCsv(text, detectDelimiter(text));
  const header = rows[0];
  if (!header) return null;
  const date = findColumn(header, HEADERS.date);
  const amount = findColumn(header, HEADERS.amount);
  const description = findColumn(header, HEADERS.description);
  if (date < 0 || amount < 0 || description < 0) return null;
  const id = findColumn(header, HEADERS.id);
  const kind: Kind = id >= 0 || fold(header[amount] ?? "") === "valor" ? "account" : "card";
  return { columns: { date, amount, description, category: findColumn(header, HEADERS.category), id, kind }, rows };
}

function parse(input: ParserInput): ParseResult {
  const parsed = readHeader(input.text);
  if (!parsed) {
    throw new BankFormatError(
      "Unrecognised Nubank header. Expected a card export (date,title,amount) or an account export (Data,Valor,Identificador,Descrição).",
    );
  }
  const { columns: c, rows } = parsed;
  const transactions: ParsedTransaction[] = [];
  const warnings: string[] = [];
  let skippedDate = 0;
  let skippedAmount = 0;

  for (const row of rows.slice(1)) {
    const date = parseDate(row[c.date] ?? "");
    if (!date) {
      skippedDate++;
      continue;
    }
    const cents = parseAmountToCents(row[c.amount] ?? "");
    if (cents === null) {
      skippedAmount++;
      continue;
    }
    const description = (row[c.description] ?? "").replace(/\s+/g, " ").trim();
    const { merchant, installment } = splitInstallment(description);
    const printedCategory = (c.category >= 0 ? (row[c.category] ?? "").trim() : "") || "uncategorized";
    const amountCents = c.kind === "account" ? -cents : cents;
    // Settling a card bill is not spending: the payment received on a card invoice, and the matching outflow from the account.
    const category =
      c.kind === "card" && amountCents < 0 && /pagamento/i.test(description)
        ? "payment"
        : c.kind === "account" && amountCents > 0 && /pagamento (da|de) fatura/i.test(fold(description))
          ? "card-bill"
          : printedCategory;
    transactions.push({
      date,
      description,
      merchant: merchant || description || "(no description)",
      category,
      // Card exports list purchases as positive; account exports list money out as negative.
      amountCents,
      kind: c.kind,
      installment,
      location: null,
      foreign: null,
    });
  }

  if (skippedDate) warnings.push(`${skippedDate} row(s) skipped: unreadable date.`);
  if (skippedAmount) warnings.push(`${skippedAmount} row(s) skipped: unreadable amount.`);
  return { kind: c.kind, transactions, warnings, meta: {} };
}

export const nubank: BankParser = {
  id: "nubank",
  name: "Nubank",
  formats: ["csv"],
  description: "CSV exports: card invoice (date,title,amount) and account statement (Data,Valor,Identificador,Descrição).",
  detect: (input) => input.format === "csv" && readHeader(input.text) !== null,
  parse,
};
