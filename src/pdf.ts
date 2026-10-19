import { extractText, getDocumentProxy } from "unpdf";
import { UserFacingError } from "./errors.js";

export class PdfError extends UserFacingError {}

const MAX_PAGES = 60;
const MAX_TEXT_CHARS = 2_000_000;

/**
 * Text of a PDF, all pages joined. Runs entirely in-process: no network, no external programs.
 * A password is only used to open the file; it is never stored or logged.
 */
export async function extractPdfText(data: Uint8Array, password?: string): Promise<string> {
  let pdf;
  try {
    // pdf.js transfers the buffer it is given, so hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(data), password ? { password } : {});
  } catch (error) {
    if ((error as { name?: string }).name === "PasswordException") {
      throw new PdfError(
        password
          ? "The PDF is password protected and the configured password did not open it."
          : "The PDF is password protected. Set INVOICES_PDF_PASSWORD to open it.",
      );
    }
    throw new PdfError("The file could not be read as a PDF.");
  }
  if (pdf.numPages > MAX_PAGES) throw new PdfError(`The PDF has more than ${MAX_PAGES} pages.`);

  try {
    const { text } = await extractText(pdf, { mergePages: true });
    if (text.length > MAX_TEXT_CHARS) throw new PdfError("The PDF contains an unexpectedly large amount of text.");
    return text;
  } catch (error) {
    if (error instanceof PdfError) throw error;
    throw new PdfError("Text could not be extracted from the PDF.");
  } finally {
    await pdf.loadingTask.destroy();
  }
}
