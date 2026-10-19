/**
 * A tiny PDF writer for tests: pages of plain text lines in Helvetica (WinAnsi, so ç/ã/é work).
 * Produces a valid PDF that real PDF text extractors can read, with no external dependency.
 */
export function makePdf(pages: string[][]): Buffer {
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return objects.length; // object numbers start at 1
  };

  // 1 = catalog, 2 = pages tree, 3 = font; page and content objects follow.
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // placeholder for the pages tree
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  const pageIds: number[] = [];
  for (const lines of pages) {
    const stream = ["BT", "/F1 9 Tf", "11 TL", "36 800 Td", ...lines.map((l) => `(${escape(l)}) '`), "ET"].join("\n");
    const contentId = add(
      Buffer.concat([Buffer.from(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n`, "latin1"), Buffer.from(stream, "latin1"), Buffer.from("\nendstream", "latin1")]),
    );
    pageIds.push(
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`),
    );
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`, "latin1");

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let position = chunks[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(chunk);
    position += chunk.length;
  });

  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}
