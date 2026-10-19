import { UserFacingError } from "./errors.js";

/** Banks with a parser. Adding a bank means adding an id here and a module in src/banks/. */
export type BankId = "nubank" | "itau";
export type Kind = "card" | "account";
export type FileFormat = "csv" | "pdf";

export interface Transaction {
  bank: BankId;
  /** ISO date, YYYY-MM-DD */
  date: string;
  /** Raw description as exported */
  description: string;
  /** Description without installment suffix, whitespace collapsed */
  merchant: string;
  category: string;
  /** Positive = money out, negative = money in (refund, payment, deposit) */
  amountCents: number;
  kind: Kind;
  /** e.g. "2/10" when the line is an installment purchase */
  installment: string | null;
  /** City or place, when the bank prints one */
  location: string | null;
  /** Original foreign-currency amount, e.g. "8,99 GBP", for international purchases */
  foreign: string | null;
  /** Invoice (file) this row came from */
  invoice: string;
}

export type ParsedTransaction = Omit<Transaction, "bank" | "invoice">;

export interface InvoiceMeta {
  /** Payment due date, YYYY-MM-DD, when the file states one */
  dueDate?: string;
  /** Invoice month YYYY-MM, when the parser can tell */
  month?: string;
  /** Total the statement itself prints for the current charges, in cents */
  statementTotalCents?: number;
  /** What the parsed lines add up to, in cents (compare with statementTotalCents) */
  parsedTotalCents?: number;
}

export interface ParseResult {
  kind: Kind;
  transactions: ParsedTransaction[];
  /** Human-readable notes. Never contain row contents. */
  warnings: string[];
  meta: InvoiceMeta;
}

/** What a bank parser is given: the file's name, its format, and its text (decoded CSV or extracted PDF text). */
export interface ParserInput {
  fileName: string;
  format: FileFormat;
  text: string;
}

export interface BankParser {
  id: BankId;
  name: string;
  formats: FileFormat[];
  /** One line shown to users: what exactly is supported */
  description: string;
  /** Cheap, side-effect-free check: does this file look like this bank's export? */
  detect(input: ParserInput): boolean;
  /** Throws BankFormatError when the file is recognised but cannot be read. */
  parse(input: ParserInput): ParseResult;
}

export class BankFormatError extends UserFacingError {}
