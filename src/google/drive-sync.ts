import { promises as fs } from "node:fs";
import { formatOf } from "../ingest.js";
import { assertFolderId, type DriveFile, type DriveSource } from "./drive-api.js";
import { MAX_DOWNLOAD_BYTES, exists, safeBaseName, saveIfValid, targetFor } from "./save.js";

export interface DriveSyncOptions {
  /** Most recent files to look at (1-100). */
  maxFiles: number;
  /** Files larger than this are not downloaded. */
  maxBytes?: number;
  /** Safety cap on files saved in one run. */
  maxSavedFiles?: number;
  /** Opens password-protected PDFs for validation. Never stored or logged. */
  pdfPassword?: string | undefined;
}

export interface DriveSyncReport {
  filesInFolder: number;
  candidates: number;
  saved: string[];
  alreadyDownloaded: number;
  rejected: { reason: string; count: number }[];
}

const DEFAULT_MAX_SAVED = 50;

/** The format a Drive file claims to be, from its name or MIME type. Google Docs/Sheets are not downloadable files. */
function claimedFormat(file: DriveFile): "csv" | "pdf" | null {
  const byName = formatOf(file.name);
  if (byName) return byName;
  if (/^text\/csv\b/i.test(file.mimeType)) return "csv";
  if (/^application\/pdf\b/i.test(file.mimeType)) return "pdf";
  return null;
}

/**
 * Copy new CSV/PDF invoices from ONE Drive folder into the local invoice folder.
 *
 * The folder is fixed by whoever starts the server; nothing here lets an agent choose another.
 * Only files directly inside that folder are considered (no subfolders), and a file is saved
 * only if one of the bank parsers recognises and can read it.
 */
export async function syncDriveInvoices(
  source: DriveSource,
  folderId: string,
  destDir: string,
  opts: DriveSyncOptions,
): Promise<DriveSyncReport> {
  assertFolderId(folderId);
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const maxSaved = opts.maxSavedFiles ?? DEFAULT_MAX_SAVED;

  await fs.mkdir(destDir, { recursive: true });
  const root = await fs.realpath(destDir);

  const rejected = new Map<string, number>();
  const reject = (reason: string) => rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
  const report: DriveSyncReport = { filesInFolder: 0, candidates: 0, saved: [], alreadyDownloaded: 0, rejected: [] };

  const files = await source.listFolder(folderId, opts.maxFiles);
  report.filesInFolder = files.length;

  for (const file of files) {
    if (/^application\/vnd\.google-apps\./.test(file.mimeType)) {
      // Folders, Docs, Sheets: not plain files. A Sheet can be exported as CSV from Drive and re-uploaded.
      if (file.mimeType !== "application/vnd.google-apps.folder") reject("Google Docs/Sheets file (export it as CSV or PDF)");
      continue;
    }
    const format = claimedFormat(file);
    if (!format) continue;
    report.candidates++;

    // Drive ids are [A-Za-z0-9_-]; refuse anything else before it reaches a file name.
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(file.id)) {
      reject("unexpected file id");
      continue;
    }
    if (!file.parents.includes(folderId)) {
      reject("not directly inside the configured folder");
      continue;
    }
    if (report.saved.length >= maxSaved) {
      reject("save limit reached for this run");
      continue;
    }
    if (file.size > maxBytes) {
      reject("file larger than 5 MB");
      continue;
    }

    const name = `drive-${file.id.slice(0, 12)}-${safeBaseName(file.name)}.${format}`;
    const target = targetFor(root, name);
    if (!target) {
      reject("unsafe file name");
      continue;
    }
    if (await exists(target)) {
      report.alreadyDownloaded++;
      continue;
    }

    const data = await source.download(file);
    if (data.length > maxBytes) {
      reject("file larger than 5 MB");
      continue;
    }
    const outcome = await saveIfValid(target, data, { pdfPassword: opts.pdfPassword });
    if (outcome.status === "saved") report.saved.push(name);
    else if (outcome.status === "exists") report.alreadyDownloaded++;
    else reject(outcome.reason);
  }

  report.rejected = [...rejected].map(([reason, count]) => ({ reason, count }));
  return report;
}
