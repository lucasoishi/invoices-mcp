/**
 * Bank-neutral parsing helpers: CSV reading, dates, money, merchant names.
 * Money is always handled as integer cents so sums never pick up floating-point noise.
 */

/** Lower-case, accent-free, trimmed: for comparing headers and names. */
export const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF, BOM. */
export function parseCsv(input: string, delimiter: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** Pick comma or semicolon by looking at the header line. */
export function detectDelimiter(input: string): string {
  const firstLine = input.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semis = (firstLine.match(/;/g) ?? []).length;
  return semis > commas ? ";" : ",";
}

/** Valid calendar date from parts, as YYYY-MM-DD, or null. */
export function isoDate(y: number, m: number, d: number): string | null {
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "2026-09-05" or "05/09/2026" -> "2026-09-05". */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (match) return isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
  return null;
}

/**
 * "45.90", "45,90", "1.234,56", "1,234.56", "R$ 1.234,56", "-12,30", "- 139,98", "(12.30)" -> cents.
 * Returns null for anything that is not clearly a money amount.
 */
export function parseAmountToCents(raw: string): number | null {
  let s = raw.replace(/R\$|\s| /g, "");
  if (!s) return null;

  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let decimalSep: "," | "." | null = null;
  if (lastComma >= 0 && lastDot >= 0) {
    decimalSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma >= 0) {
    decimalSep = /,\d{1,2}$/.test(s) ? "," : null;
  } else if (lastDot >= 0) {
    decimalSep = /\.\d{1,2}$/.test(s) ? "." : null;
  }

  let intPart = s;
  let fracPart = "";
  if (decimalSep) {
    const idx = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, idx);
    fracPart = s.slice(idx + 1);
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d{1,2}$/.test(fracPart))) return null;

  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

const INSTALLMENT_RE = /\s*-?\s*parcela\s+(\d+)\s*\/\s*(\d+)/i;

export function splitInstallment(description: string): { merchant: string; installment: string | null } {
  const match = INSTALLMENT_RE.exec(description);
  const merchant = description.replace(INSTALLMENT_RE, "").replace(/\s+/g, " ").trim();
  return { merchant, installment: match ? `${match[1]}/${match[2]}` : null };
}

/** Case- and accent-insensitive key for grouping the same merchant. */
export function merchantKey(merchant: string): string {
  return fold(merchant).replace(/\s+/g, " ");
}
