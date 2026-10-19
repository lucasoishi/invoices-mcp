import { describeSupport, PARSERS } from "./banks/index.js";
import { UserFacingError } from "./errors.js";
import { extractPdfText } from "./pdf.js";
import type { BankParser, FileFormat, ParseResult } from "./types.js";

export class UnsupportedFormatError extends UserFacingError {}

export interface IngestOptions {
  /** Opens password-protected PDFs. Never stored or logged. */
  pdfPassword?: string | undefined;
}

export function formatOf(fileName: string): FileFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}

/**
 * Turn the bytes of one file into transactions: extract its text (PDFs), let each bank's parser
 * say whether it recognises the file, and parse with the one that does.
 * Used both for files on disk and for attachments before they are saved.
 */
export async function ingest(
  fileName: string,
  bytes: Uint8Array,
  options: IngestOptions = {},
): Promise<{ parser: BankParser; result: ParseResult }> {
  const format = formatOf(fileName);
  if (!format) throw new UnsupportedFormatError("Only .csv and .pdf files are supported.");

  const text = format === "pdf" ? await extractPdfText(bytes, options.pdfPassword) : Buffer.from(bytes).toString("utf8");
  const input = { fileName, format, text };

  const parser = PARSERS.find((p) => p.formats.includes(format) && p.detect(input));
  if (!parser) {
    throw new UnsupportedFormatError(`No supported bank format was recognised. Supported: ${describeSupport()}.`);
  }
  return { parser, result: parser.parse(input) };
}
