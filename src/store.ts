import { promises as fs } from "node:fs";
import path from "node:path";
import { UserFacingError } from "./errors.js";
import { formatOf, ingest } from "./ingest.js";
import type { BankId, InvoiceMeta, Kind, Transaction } from "./types.js";

export interface Invoice {
  /** File name without extension, e.g. "Nubank_2026-09-04" */
  id: string;
  bank: BankId;
  /** YYYY-MM: the invoice's due month when the file says so, else the month in the file name, else the most common transaction month */
  month: string | null;
  kind: Kind;
  transactions: Transaction[];
  warnings: string[];
  meta: InvoiceMeta;
}

export interface LoadResult {
  invoices: Invoice[];
  skippedFiles: { file: string; reason: string }[];
}

export interface StoreOptions {
  pdfPassword?: string | undefined;
}

const MAX_FILES = 500;
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Read-only access to the .csv and .pdf files that sit directly inside one folder.
 *
 * Privacy guarantees enforced here:
 *  - only top-level `*.csv` / `*.pdf` files are read (no recursion)
 *  - a file whose real path leaves the folder (e.g. a symlink) is skipped
 *  - nothing is ever written, and nothing is sent over the network
 */
export class InvoiceStore {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; invoice: Invoice }>();

  constructor(
    private readonly dir: string,
    private readonly options: StoreOptions = {},
  ) {}

  async load(): Promise<LoadResult> {
    const root = await fs.realpath(this.dir);
    const entries = await fs.readdir(root, { withFileTypes: true });
    const names = entries
      .filter((e) => !e.isDirectory() && formatOf(e.name) !== null)
      .map((e) => e.name)
      .sort();

    const invoices: Invoice[] = [];
    const skippedFiles: LoadResult["skippedFiles"] = [];

    if (names.length > MAX_FILES) {
      skippedFiles.push({ file: "(folder)", reason: `More than ${MAX_FILES} invoice files; only the first ${MAX_FILES} were read.` });
    }

    for (const name of names.slice(0, MAX_FILES)) {
      const full = path.join(root, name);
      try {
        const real = await fs.realpath(full);
        const rel = path.relative(root, real);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          skippedFiles.push({ file: name, reason: "Resolves to a path outside the folder." });
          continue;
        }
        const stat = await fs.stat(real);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_BYTES) {
          skippedFiles.push({ file: name, reason: "File is larger than 10 MB." });
          continue;
        }

        const cached = this.cache.get(real);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          invoices.push(cached.invoice);
          continue;
        }

        const id = name.replace(/\.(csv|pdf)$/i, "");
        const { parser, result } = await ingest(name, await fs.readFile(real), { pdfPassword: this.options.pdfPassword });
        const transactions: Transaction[] = result.transactions.map((t) => ({ ...t, bank: parser.id, invoice: id }));
        const invoice: Invoice = {
          id,
          bank: parser.id,
          month: result.meta.month ?? monthFromName(id) ?? dominantMonth(transactions),
          kind: result.kind,
          transactions,
          warnings: result.warnings,
          meta: result.meta,
        };
        this.cache.set(real, { mtimeMs: stat.mtimeMs, size: stat.size, invoice });
        invoices.push(invoice);
      } catch (error) {
        const reason = error instanceof UserFacingError ? error.message : "Could not be read.";
        skippedFiles.push({ file: name, reason });
      }
    }

    invoices.sort((a, b) => (a.month ?? "").localeCompare(b.month ?? "") || a.bank.localeCompare(b.bank) || a.id.localeCompare(b.id));
    return { invoices, skippedFiles };
  }
}

function monthFromName(id: string): string | null {
  const match = /(\d{4})-(\d{2})/.exec(id);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${match[2]}` : null;
}

function dominantMonth(transactions: Transaction[]): string | null {
  const counts = new Map<string, number>();
  for (const t of transactions) {
    const m = t.date.slice(0, 7);
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [m, c] of counts) {
    if (c > bestCount) {
      best = m;
      bestCount = c;
    }
  }
  return best;
}
