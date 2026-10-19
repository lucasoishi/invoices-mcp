import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  applyFilter,
  brl,
  compareMonths,
  findRecurring,
  monthlyTotals,
  summarize,
  toPublic,
  totals,
  type Filter,
} from "./analytics.js";
import { PARSERS, supportedBanks } from "./banks/index.js";
import { UserFacingError } from "./errors.js";
import type { DriveSyncReport } from "./google/drive-sync.js";
import type { SyncReport } from "./google/gmail-sync.js";
import type { InvoiceStore } from "./store.js";
import type { BankId } from "./types.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");
const bankIds = PARSERS.map((p) => p.id) as [BankId, ...BankId[]];
const bank = z.enum(bankIds).optional().describe(`Only this bank: ${bankIds.join(", ")}. Omit to include every bank.`);

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CONVENTIONS =
  "Amounts are in BRL. A positive amount is money leaving the account or card (a purchase or fee); " +
  "refunds, card payments and deposits are reported separately as credits.";

class UserError extends UserFacingError {}

/** Optional Gmail integration, supplied only when the user configured it at startup. */
export interface GmailSync {
  sync(opts: { maxMessages: number }): Promise<SyncReport>;
}

/** Optional Google Drive integration: one fixed folder, supplied only when configured at startup. */
export interface DriveSync {
  sync(opts: { maxFiles: number }): Promise<DriveSyncReport>;
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const fail = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

export function createServer(store: InvoiceStore, version: string, gmail?: GmailSync, drive?: DriveSync): McpServer {
  const server = new McpServer({ name: "invoices-mcp", version });

  async function load() {
    let result;
    try {
      result = await store.load();
    } catch {
      throw new UserError("The configured invoice folder could not be read. Check the --dir path or INVOICES_DIR.");
    }
    if (result.invoices.length === 0) {
      const why = result.skippedFiles.map((s) => `${s.file}: ${s.reason}`).join("; ");
      throw new UserError(
        "No readable invoice files were found in the configured folder. " +
          `Supported: ${supportedBanks().map((b) => `${b.name} (${b.formats.join("/")})`).join(", ")}.` +
          (why ? ` Skipped: ${why}` : ""),
      );
    }
    return result;
  }

  const guarded =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        return ok(await fn(args));
      } catch (error) {
        if (error instanceof UserFacingError) return fail(error.message);
        return fail("Something went wrong while reading the invoices.");
      }
    };

  server.registerTool(
    "list_banks",
    {
      title: "List supported banks",
      description:
        "Which banks and file formats this server can read. Files from other banks are not supported yet and are reported as skipped by list_invoices.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(async () => ({
      banks: supportedBanks(),
      note: "Support for more banks is planned. Files from other banks are skipped, never guessed at.",
    })),
  );

  server.registerTool(
    "list_invoices",
    {
      title: "List invoices",
      description:
        "List the invoice files that were found: bank, month, type (card or account), due date, transaction count and spend. " +
        "Where a statement prints its own total, `check` says whether the parsed lines add up to it. " +
        `Files that could not be read are listed under skippedFiles. ${CONVENTIONS}`,
      inputSchema: { bank },
      annotations: READ_ONLY,
    },
    guarded(async (args: { bank?: BankId }) => {
      const { invoices, skippedFiles } = await load();
      return {
        invoices: invoices
          .filter((inv) => !args.bank || inv.bank === args.bank)
          .map((inv) => ({
            invoice: inv.id,
            bank: inv.bank,
            month: inv.month,
            type: inv.kind,
            dueDate: inv.meta.dueDate ?? null,
            transactionCount: inv.transactions.length,
            ...totals(inv.transactions),
            check:
              inv.meta.statementTotalCents === undefined
                ? null
                : {
                    statementTotalBRL: brl(inv.meta.statementTotalCents),
                    parsedTotalBRL: brl(inv.meta.parsedTotalCents ?? 0),
                    matchesStatement: inv.meta.statementTotalCents === inv.meta.parsedTotalCents,
                  },
            warnings: inv.warnings,
          })),
        skippedFiles,
      };
    }),
  );

  server.registerTool(
    "spending_summary",
    {
      title: "Spending summary",
      description:
        `Totals, spend by bank and category, top merchants and largest purchases. Optionally narrow by bank, invoice, date range or category. ${CONVENTIONS}`,
      inputSchema: {
        bank,
        invoice: z.string().optional().describe("Invoice id from list_invoices, e.g. Nubank_2026-09-04"),
        from: isoDate.optional().describe("Start date, inclusive"),
        to: isoDate.optional().describe("End date, inclusive"),
        category: z.string().optional().describe("Category name as shown in the export"),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args: { bank?: BankId; invoice?: string; from?: string; to?: string; category?: string }) => {
      const { invoices } = await load();
      if (args.invoice && !invoices.some((i) => i.id === args.invoice)) {
        throw new UserError(`Unknown invoice "${args.invoice}". Call list_invoices to see the available ids.`);
      }
      const filter: Filter = {
        ...(args.bank && { bank: args.bank }),
        ...(args.invoice && { invoice: args.invoice }),
        ...(args.from && { from: args.from }),
        ...(args.to && { to: args.to }),
        ...(args.category && { category: args.category }),
      };
      return summarize(
        applyFilter(
          invoices.flatMap((i) => i.transactions),
          filter,
        ),
      );
    }),
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        `Find individual transactions by text, bank, date range, category or amount, newest first. min_amount and max_amount compare the absolute amount in BRL. ${CONVENTIONS}`,
      inputSchema: {
        query: z.string().optional().describe("Text to look for in the description (case and accent insensitive)"),
        bank,
        from: isoDate.optional(),
        to: isoDate.optional(),
        category: z.string().optional(),
        invoice: z.string().optional(),
        min_amount: z.number().nonnegative().optional(),
        max_amount: z.number().nonnegative().optional(),
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum rows to return (default 50, max 200)"),
      },
      annotations: READ_ONLY,
    },
    guarded(
      async (args: {
        query?: string;
        bank?: BankId;
        from?: string;
        to?: string;
        category?: string;
        invoice?: string;
        min_amount?: number;
        max_amount?: number;
        limit: number;
      }) => {
        const { invoices } = await load();
        const filter: Filter = {
          ...(args.query !== undefined && { query: args.query }),
          ...(args.bank !== undefined && { bank: args.bank }),
          ...(args.from !== undefined && { from: args.from }),
          ...(args.to !== undefined && { to: args.to }),
          ...(args.category !== undefined && { category: args.category }),
          ...(args.invoice !== undefined && { invoice: args.invoice }),
          ...(args.min_amount !== undefined && { minCents: Math.round(args.min_amount * 100) }),
          ...(args.max_amount !== undefined && { maxCents: Math.round(args.max_amount * 100) }),
        };
        const matches = applyFilter(
          invoices.flatMap((i) => i.transactions),
          filter,
        ).sort((a, b) => b.date.localeCompare(a.date));
        return {
          matchCount: matches.length,
          matchSpendBRL: totals(matches).spendBRL,
          matchNetSpendBRL: totals(matches).netSpendBRL,
          returned: Math.min(matches.length, args.limit),
          transactions: matches.slice(0, args.limit).map(toPublic),
        };
      },
    ),
  );

  server.registerTool(
    "monthly_totals",
    {
      title: "Monthly totals",
      description: `Spend and credits per calendar month, optionally for one bank or category. Months come from transaction dates. ${CONVENTIONS}`,
      inputSchema: { bank, category: z.string().optional() },
      annotations: READ_ONLY,
    },
    guarded(async (args: { bank?: BankId; category?: string }) => {
      const { invoices } = await load();
      const filter: Filter = { ...(args.bank && { bank: args.bank }), ...(args.category && { category: args.category }) };
      return {
        months: monthlyTotals(
          applyFilter(
            invoices.flatMap((i) => i.transactions),
            filter,
          ),
        ),
      };
    }),
  );

  server.registerTool(
    "compare_months",
    {
      title: "Compare two months",
      description: `Compare spending by category between two calendar months and show what changed most. ${CONVENTIONS}`,
      inputSchema: {
        month_a: month.describe("Earlier month, YYYY-MM"),
        month_b: month.describe("Later month, YYYY-MM"),
        bank,
      },
      annotations: READ_ONLY,
    },
    guarded(async (args: { month_a: string; month_b: string; bank?: BankId }) => {
      const { invoices } = await load();
      return compareMonths(
        applyFilter(
          invoices.flatMap((i) => i.transactions),
          args.bank ? { bank: args.bank } : {},
        ),
        args.month_a,
        args.month_b,
      );
    }),
  );

  server.registerTool(
    "find_recurring_charges",
    {
      title: "Find recurring charges",
      description:
        "Detect likely subscriptions: the same merchant charged a similar amount (within 5%), about once a month, in several different months. " +
        `Installment purchases are ignored. ${CONVENTIONS}`,
      inputSchema: {
        bank,
        min_months: z.number().int().min(2).max(24).default(3).describe("Months a charge must appear in (default 3)"),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args: { bank?: BankId; min_months: number }) => {
      const { invoices } = await load();
      const recurring = findRecurring(
        applyFilter(
          invoices.flatMap((i) => i.transactions),
          args.bank ? { bank: args.bank } : {},
        ),
        args.min_months,
      );
      return {
        recurring,
        totalMonthlyBRL: Math.round(recurring.reduce((a, r) => a + r.typicalAmountBRL, 0) * 100) / 100,
      };
    }),
  );

  if (gmail) {
    server.registerTool(
      "sync_gmail_invoices",
      {
        title: "Fetch new invoices from Gmail",
        description:
          "Download new invoice attachments (CSV or PDF) from Gmail into the local invoice folder, then call list_invoices to see them. " +
          "The Gmail search is fixed by the person who configured this server (it cannot be changed from here), and an attachment " +
          "is only kept if one of the supported bank parsers recognises and can read it. Gmail access is read-only. " +
          "This tool uses the network and writes files.",
        inputSchema: {
          max_messages: z.number().int().min(1).max(100).default(25).describe("Most recent matching emails to check (default 25)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      guarded(async (args: { max_messages: number }) => {
        const report = await gmail.sync({ maxMessages: args.max_messages });
        return { ...report, next: report.saved.length ? "Call list_invoices to see the new files." : "Nothing new was saved." };
      }),
    );
  }

  if (drive) {
    server.registerTool(
      "sync_drive_invoices",
      {
        title: "Fetch new invoices from Google Drive",
        description:
          "Copy new invoice files (CSV or PDF) from the one Google Drive folder this server was configured with into the local " +
          "invoice folder, then call list_invoices to see them. The folder is fixed by the person who configured the server " +
          "(it cannot be changed from here), subfolders are not read, and a file is only kept if one of the supported bank " +
          "parsers recognises and can read it. Drive access is read-only: nothing in Drive is changed. " +
          "This tool uses the network and writes files.",
        inputSchema: {
          max_files: z.number().int().min(1).max(100).default(50).describe("Most recent files to look at (default 50)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      guarded(async (args: { max_files: number }) => {
        const report = await drive.sync({ maxFiles: args.max_files });
        return { ...report, next: report.saved.length ? "Call list_invoices to see the new files." : "Nothing new was saved." };
      }),
    );
  }

  return server;
}
