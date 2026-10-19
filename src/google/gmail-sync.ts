import { promises as fs } from "node:fs";
import { formatOf } from "../ingest.js";
import type { AttachmentRef, GmailSource } from "./gmail-api.js";
import { GoogleError } from "./auth.js";
import { MAX_DOWNLOAD_BYTES, exists, safeBaseName, saveIfValid, targetFor } from "./save.js";

export { safeBaseName };

export interface SyncOptions {
  maxMessages: number;
  /** Attachments larger than this are not downloaded. */
  maxAttachmentBytes?: number;
  /** Safety cap on files saved in one run. */
  maxSavedFiles?: number;
  /** Opens password-protected PDF attachments for validation. Never stored or logged. */
  pdfPassword?: string | undefined;
}

export interface SyncReport {
  messagesChecked: number;
  attachmentsFound: number;
  saved: string[];
  alreadyDownloaded: number;
  rejected: { reason: string; count: number }[];
}

const DEFAULT_MAX_BYTES = MAX_DOWNLOAD_BYTES;
const DEFAULT_MAX_SAVED = 50;

/**
 * The query is chosen by the person who starts the server, never by the agent.
 * Only CSV and PDF attachments are ever considered.
 */
export function buildQuery(userQuery: string): string {
  return `(${userQuery.trim()}) has:attachment (filename:csv OR filename:pdf)`;
}

/** A query must name a sender, label or subject so a whole mailbox is never swept. */
export function assertScopedQuery(userQuery: string): void {
  if (!/\b(from|label|subject):\S+/i.test(userQuery)) {
    throw new GoogleError(
      'The Gmail query must include from:, label: or subject: (for example "label:invoices") so the search stays narrow.',
    );
  }
}

/** The format an attachment claims to be, from its file name or MIME type. */
function claimedFormat(ref: AttachmentRef): "csv" | "pdf" | null {
  const byName = formatOf(ref.filename);
  if (byName) return byName;
  if (/^text\/csv\b/i.test(ref.mimeType)) return "csv";
  if (/^application\/pdf\b/i.test(ref.mimeType)) return "pdf";
  return null;
}

export async function syncGmailInvoices(
  source: GmailSource,
  userQuery: string,
  destDir: string,
  opts: SyncOptions,
): Promise<SyncReport> {
  assertScopedQuery(userQuery);
  const maxBytes = opts.maxAttachmentBytes ?? DEFAULT_MAX_BYTES;
  const maxSaved = opts.maxSavedFiles ?? DEFAULT_MAX_SAVED;

  await fs.mkdir(destDir, { recursive: true });
  const root = await fs.realpath(destDir);

  const rejected = new Map<string, number>();
  const reject = (reason: string) => rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
  const report: SyncReport = { messagesChecked: 0, attachmentsFound: 0, saved: [], alreadyDownloaded: 0, rejected: [] };

  const ids = await source.listMessageIds(buildQuery(userQuery), opts.maxMessages);
  for (const id of ids) {
    report.messagesChecked++;
    // Gmail message ids are hex strings; refuse anything else before it reaches a file name.
    if (!/^[0-9a-f]{6,32}$/i.test(id)) {
      reject("unexpected message id");
      continue;
    }

    for (const ref of await source.listAttachments(id)) {
      const format = claimedFormat(ref);
      if (!format) continue;
      report.attachmentsFound++;
      if (report.saved.length >= maxSaved) {
        reject("save limit reached for this run");
        continue;
      }
      if (ref.size > maxBytes) {
        reject("attachment larger than 5 MB");
        continue;
      }

      const name = `gmail-${id}-${safeBaseName(ref.filename)}.${format}`;
      const target = targetFor(root, name);
      if (!target) {
        reject("unsafe file name");
        continue;
      }
      if (await exists(target)) {
        report.alreadyDownloaded++;
        continue;
      }

      const data = await source.downloadAttachment(ref);
      if (data.length > maxBytes) {
        reject("attachment larger than 5 MB");
        continue;
      }
      // Only keep files that one of the bank parsers recognises and can read; anything else is discarded unsaved.
      const outcome = await saveIfValid(target, data, { pdfPassword: opts.pdfPassword });
      if (outcome.status === "saved") report.saved.push(name);
      else if (outcome.status === "exists") report.alreadyDownloaded++;
      else reject(outcome.reason);
    }
  }

  report.rejected = [...rejected].map(([reason, count]) => ({ reason, count }));
  return report;
}

