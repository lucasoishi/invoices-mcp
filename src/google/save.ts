/**
 * The safe way to put a downloaded file into the invoice folder, shared by every remote source
 * (Gmail, Drive). The rules live in one place so a source cannot forget one:
 *   - the file name is rebuilt from safe characters, so `../../x.csv` cannot leave the folder
 *   - nothing is written unless one of the bank parsers recognises and can read the file
 *   - an existing file is never overwritten
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { UnsupportedFormatError, ingest } from "../ingest.js";
import { PdfError } from "../pdf.js";
import { BankFormatError } from "../types.js";

export const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

/** `../../x y.csv` -> `x-y`. Only [A-Za-z0-9._-], at most 60 characters, extension removed. */
export function safeBaseName(filename: string): string {
  const base = path.basename(filename.replace(/\\/g, "/")).replace(/\.(csv|pdf)$/i, "");
  const cleaned = base
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60);
  return cleaned || "attachment";
}

/** Why a file was not kept: short, stable, and never containing file contents. */
export function rejectionReason(error: unknown): string {
  if (error instanceof UnsupportedFormatError) return "not a recognised bank invoice";
  if (error instanceof PdfError) return "PDF could not be opened";
  if (error instanceof BankFormatError) return "recognised bank format but unreadable";
  return "could not be checked";
}

/** The absolute path a file would be saved to, or null if it would not sit directly inside `root`. */
export function targetFor(root: string, name: string): string | null {
  const target = path.join(root, name);
  return path.dirname(target) === root ? target : null;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export type SaveOutcome = { status: "saved" } | { status: "exists" } | { status: "rejected"; reason: string };

/** Validate with the bank parsers, then write without overwriting. */
export async function saveIfValid(
  target: string,
  data: Buffer,
  options: { pdfPassword?: string | undefined } = {},
): Promise<SaveOutcome> {
  try {
    const { result } = await ingest(path.basename(target), data, options);
    if (result.transactions.length === 0) throw new BankFormatError("empty");
  } catch (error) {
    return { status: "rejected", reason: rejectionReason(error) };
  }
  try {
    await fs.writeFile(target, data, { flag: "wx" }); // never overwrite
    return { status: "saved" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "exists" };
    throw error;
  }
}
