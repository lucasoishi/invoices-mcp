# invoices-mcp

A small [MCP](https://modelcontextprotocol.io) server that lets an AI agent answer questions about **your own bank invoices** — "what did I spend on food in September?", "which subscriptions am I paying for?", "what changed between August and September?" — without your financial data going anywhere you didn't choose.

You drop invoice files in a folder. The server works out which bank each file is from, reads it with that bank's parser, and gives the agent a handful of narrow, read-only tools.

## Supported banks

| Bank | Files | What is read |
|---|---|---|
| **Nubank** | CSV | Card invoice (`date,title,amount`, as e-mailed in *Extrato da fatura*; a category column is optional) and account statement (`Data,Valor,Identificador,Descrição`) |
| **Itaú** | PDF | Credit-card statement (*Fatura*): purchases, installments, cancellations, international purchases (with conversion rate), IOF and payments |

**More banks are planned but not built yet.** A file from any other bank is not guessed at: it is reported as skipped, with the list of supported banks, by `list_invoices`. See [Adding a bank](#adding-a-bank).

- **Free.** No service to pay for, no account of ours, no API key.
- **Private by default.** It reads files from one folder you choose. In its default mode it makes no network requests and never writes to disk. This is enforced by tests, not just promised (see [Privacy](#privacy)).
- **Checks its own work.** Where a statement prints its own total, the server compares it with the sum of the lines it parsed and says so (`check.matchesStatement`), instead of silently trusting a regular expression.
- **Optional Gmail and Google Drive.** If invoices reach you by e-mail, or live in a Drive folder, the server can fetch them for you — read-only, off unless you turn it on. See [Gmail and Drive](#optional-fetch-invoices-from-gmail-or-google-drive).

> **Status: v0.4.** Nubank is verified on a real mailbox. Itaú is verified on three real statements (every one adds up to its printed total) plus synthetic ones, including the PDF text-extraction path; run `list_invoices` on your own statement and look at `check` to confirm it adds up. If your files look different, [see what to do](#if-a-file-does-not-parse).

## How it works

```
 your files ─────────────▶  a folder  ◀──read-only──  invoices-mcp  ◀──MCP (stdio)──  your AI agent
 (Nubank CSV, Itaú PDF)        ▲                           │
                               └── optional: new files ┴── Gmail / one Drive folder (read-only)
```

For each file the server extracts its text (PDFs are read in-process, no external program), asks each bank parser "is this yours?", and parses it with the one that says yes. The agent never gets a file path and never gets raw access to the files: it calls narrow tools and receives JSON.

## Tools

| Tool | What it answers |
|---|---|
| `list_banks` | Which banks and formats are supported |
| `list_invoices` | Files found: bank, month, due date, transaction count, totals, and whether the parsed lines match the statement's own total. Unreadable files are listed under `skippedFiles` with the reason |
| `spending_summary` | Totals, spend by bank and category, top merchants, largest purchases (filter by bank, invoice, dates, category) |
| `search_transactions` | Find transactions by text, bank, date range, category or amount (newest first, max 200 rows) |
| `monthly_totals` | Spend, refunds and payments per month, optionally for one bank or category |
| `compare_months` | What changed between two months, by category, biggest change first |
| `find_recurring_charges` | Likely subscriptions: same merchant, similar amount (±5%), about once a month |
| `sync_gmail_invoices` | *Only when Gmail is configured.* Download new invoice attachments into the folder |
| `sync_drive_invoices` | *Only when a Drive folder is configured.* Copy new invoice files from that one folder into the local folder |

Every analysis tool takes an optional `bank` filter (`nubank`, `itau`).

### What "spend" means

All amounts are in BRL. Amounts are handled as integer cents, so totals never pick up floating-point noise.

| Term | Meaning |
|---|---|
| `spendBRL` | Purchases and fees (money out), before refunds |
| `refundsBRL` | Cancellations and refunds (money back) |
| `paymentsBRL` | Card-bill settlements: the payment shown on a card invoice, and the matching "pay the bill" outflow on an account statement. **Never counted as spending**, so paying a card from your account is not double-counted |
| `netSpendBRL` | `spend − refunds`: what you actually spent. A booking cancelled in the same invoice nets to zero |

Categories and merchants in summaries are net of refunds. Itaú's own category labels are normalised (`HEALTH` → `saúde`, `SUPERMARKET` → `supermercado`); international purchases are `international`, and the IOF charged on them is `fees`.

## Quick start

Requires Node.js 20 or newer.

```bash
git clone <this repo>
cd invoices-mcp
npm install
npm run build
```

1. Put your invoice files in a folder, for example `C:\Users\you\Documents\invoices` — Nubank CSVs and Itaú PDFs can sit side by side.
2. Try it on the included fake data first (one Itaú PDF and four Nubank CSVs):

```bash
node dist/index.js --dir sample
```

### Connect it to an agent

**Claude Code** — either run

```bash
claude mcp add invoices -- node /path/to/invoices-mcp/dist/index.js --dir /path/to/invoices
```

or put this in a project's `.mcp.json`. **Claude Desktop** uses the same block in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "invoices": {
      "command": "node",
      "args": ["C:/path/to/invoices-mcp/dist/index.js", "--dir", "C:/Users/you/Documents/invoices"]
    }
  }
}
```

You can also set the folder with the `INVOICES_DIR` environment variable instead of `--dir`.

### Things to ask

- "List my invoices and tell me if any of them don't add up."
- "Summarise my spending for September. What are my top three categories?"
- "Which subscriptions am I paying for, and what do they cost per year?"
- "Compare August and September on the Itaú card. What went up the most?"
- "Find every purchase over R$ 150 this quarter."

## Supported formats in detail

### Nubank (CSV)

The layout is detected from the header row; comma or semicolon delimiters both work, as do `1.234,56` and `1,234.56` style amounts and ISO or `dd/mm/yyyy` dates.

| Layout | Header | Notes |
|---|---|---|
| Card invoice | `date,title,amount` or `date,category,title,amount` | Purchases are positive; the payment received is negative and tagged `payment`. Amounts such as `"69,99"` and `"- 139,98"` are understood. Without a category column rows are `uncategorized`. `Parcela 2/10` is read as an installment |
| Account statement | `Data,Valor,Identificador,Descrição` | Negative `Valor` means money out; it is flipped to the convention above. *Pagamento da fatura* is tagged `card-bill` |

### Itaú (PDF)

The PDF's text is read and flattened (so differences in line breaks between PDF readers don't matter), then:

- the **due date** (`Vencimento`) fixes the year of every row, since rows only print `DD/MM`; a December purchase on a January statement becomes last year;
- **purchases** are read as *date, merchant, optional installment `NN/NN`, amount*, with the category and city printed underneath each row;
- **cancellations** (`CANCELAMENTO DE COMPRA`) are negative and net against the purchase;
- **international purchases** are read with their original amount and currency; the R$ figure is identified by checking which printed amount equals another times the printed *Dólar de Conversão* rate;
- the **IOF** passed on for international purchases is a `fees` line, because it is part of the invoice total;
- the **"Compras parceladas – próximas faturas"** section (future installments) is ignored: it is not charged on this invoice;
- repeated page headers, `continua...` markers and stray page numbers are discarded;
- card numbers, cardholder names and addresses are **never copied** into the result.

**Self-check.** The parsed lines are compared with the statement's *card subtotal*, its *international total* and its *Total dos lançamentos atuais*. Any difference becomes a warning, and `list_invoices` shows `check: { statementTotalBRL, parsedTotalBRL, matchesStatement }`. If it says `false`, a line was missed or misread — don't trust that invoice's numbers until it's looked at.

**Damaged text layers.** Some statements come out of the PDF with stray spaces inside words and numbers (`6.634 ,53`, `128,5 0`, `04/ 08`) and with the two columns interleaved. The parser repairs number-shaped damage and matches section headings loosely, but merchant names stay as printed (`REST AUR ANT E`), categories are not read for such statements (they are `uncategorized`), and the result carries a warning saying so. It is accepted only because the lines still add up to the printed total; a statement it cannot read, or whose total it cannot find, is rejected rather than guessed at.

**Password-protected PDFs.** If your statements need a password, set `INVOICES_PDF_PASSWORD`. It is used only to open the file and is never stored or logged.

### If a file does not parse

`list_invoices` reports skipped files with a reason, and `check` flags statements whose lines don't add up. If your file uses a different layout, open an issue describing it **without including transactions or personal data** (for a CSV, only the header line; for a PDF, which section looks different).

## Optional: fetch invoices from Gmail or Google Drive

Both are off by default, share one sign-in, and can be used together. Use **Gmail** if invoices reach you by e-mail (an exported CSV you forward to yourself, or a PDF statement a bank sends). Use **Drive** if you keep invoice files in a Drive folder. Each adds one tool — `sync_gmail_invoices`, `sync_drive_invoices` — that copies new **CSV and PDF** files into the invoice folder; everything after that, parsing and analysis, is the same local code.

### One-time setup (about 10 minutes)

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project and enable the **Gmail API** and/or the **Google Drive API** (whichever you will use).
2. Configure the **OAuth consent screen** (External) and add your own Google account as a *test user* (without this Google answers `403 access_denied`).
3. Create credentials → **OAuth client ID** → application type **Desktop app**, and download the JSON. Keep it somewhere outside this project.
4. Authorise once. This prints a URL; open it and approve **read-only** access. Say which sources you want:

   ```bash
   node dist/index.js auth --google-credentials /path/to/client.json --scopes gmail,drive
   ```

   (`--scopes gmail`, `--scopes drive` or `--scopes gmail,drive`; the default is `gmail`.) To add Drive later, run it again with the scopes you want.
5. Tell the server what to read, in your MCP configuration:

   ```json
   "args": ["C:/path/to/invoices-mcp/dist/index.js", "--dir", "C:/Users/you/Documents/invoices",
            "--google-credentials", "C:/path/to/client.json",
            "--gmail-query", "label:invoices",
            "--drive-folder", "https://drive.google.com/drive/folders/<folder id>"]
   ```

   Use either option or both. The environment variables are `INVOICES_GOOGLE_CREDENTIALS`, `INVOICES_GMAIL_QUERY` and `INVOICES_DRIVE_FOLDER`. Then ask your agent: *"Fetch new invoices from Drive and Gmail, then summarise this month."*

### How the access is kept narrow

- **The source is yours, not the agent's.** The Gmail search and the Drive folder are fixed when the server starts. The Gmail query must contain `from:`, `label:` or `subject:`; the Drive folder must be a plain folder id or folder link (anything that could alter the Drive search is refused at startup). The tools' only parameter is a count (how many recent messages or files to look at). A prompt-injected agent cannot widen the search or point the server at another folder.
- **Drive: one folder, no subfolders.** Only files listed directly in that folder are considered, and each file must report that folder as its parent. Folders, Google Docs and Google Sheets are not downloaded.
- **CSV and PDF only.** Gmail always appends `has:attachment (filename:csv OR filename:pdf)`; Drive considers only `.csv`/`.pdf` files. Images, documents and everything else are never downloaded.
- **Only real bank invoices are kept.** Every file must be recognised and read by one of the bank parsers; anything else is discarded without being saved.
- **Gmail: email text is never read.** Only the attachment structure is requested, not message bodies.
- **One safe-save routine for every source** ([`src/google/save.ts`](src/google/save.ts)): files are renamed from safe characters only (`gmail-<id>-<name>`, `drive-<id>-<name>`), so `../../x.csv` cannot leave the folder; an existing file is never overwritten or downloaded again; files are capped at 5 MB and 50 per run.
- **Read-only scopes** (`gmail.readonly`, `drive.readonly`). The Gmail and Drive clients send nothing but `GET` requests, so nothing in your mailbox or your Drive can be changed, moved, shared or trashed; tests fail if that ever stops being true.
- **Network limited to Google.** Sign-in and API calls go only to `accounts.google.com`, `oauth2.googleapis.com`, `gmail.googleapis.com` and `www.googleapis.com/drive/v3/files` (plus a loopback address for the sign-in redirect). A test fails if any other host appears.
- **Tokens.** Only a refresh token is stored, at `~/.invoices-mcp/google-token.json` (override with `INVOICES_GOOGLE_TOKEN`). Access tokens live in memory. The OAuth flow uses PKCE and checks `state`, and the credentials file is rejected if its token endpoint isn't Google's. Before each sync the server checks that the saved token actually includes the needed scope and says how to add it if not.

### Honest limits of the Google options

- **The permissions are broader than what the code does.** Google offers no narrower scope that can read Gmail attachments or the contents of an arbitrary Drive folder. So the token can technically read your **whole mailbox** (`gmail.readonly`) and **every file in your Drive** (`drive.readonly`). This server only runs the search and folder you configured, but the credential itself is powerful. Consider a **dedicated Google account** for invoices, keep the token file private, and know how to revoke access: <https://myaccount.google.com/permissions>.
- **Tokens expire weekly in "Testing" mode.** While your OAuth app is unverified, Google expires refresh tokens after 7 days; re-run `auth` when the tool says so.
- **Drive:** subfolders are not read; a file you later edit in Drive is not downloaded again (a new file name or a deleted local copy is); Google Sheets are not read (export one as CSV first).
- **Downloaded files are real financial data** sitting in your folder. Protect it like any bank statement.
- Some banks protect PDF statements with a password; set `INVOICES_PDF_PASSWORD` so they can be validated and saved.

## Privacy

Two modes, stated plainly:

**Default (no Gmail options)**
- Reads only `*.csv` and `*.pdf` files **directly inside** the configured folder (no recursion). A file whose real path leaves the folder, such as a symlink, is skipped.
- Read-only. No code path writes, renames or deletes files.
- No network access and no child processes. PDFs are read in-process. The transport is stdio only. The Gmail code is not even loaded.
- Nothing is logged: transaction contents are never written to stdout or stderr (stdout carries the MCP protocol).
- File size is capped at 10 MB and file count at 500.

**With Gmail and/or Drive enabled**
- Everything above still holds for the parsing and analysis code. The only code allowed to use the network or write files lives in `src/google/`, and only the `sync_gmail_invoices` and `sync_drive_invoices` tools reach it.

[`test/privacy.test.ts`](test/privacy.test.ts) turns this into a build failure: outside `src/google/` no source may import a network or process module, call `fetch`, or write a file; the Google modules may only mention Google hosts, may only request the two read-only scopes, may not reference mutating endpoints, and the Gmail and Drive clients may send nothing but `GET` requests; nothing may log through `console`; and no status line may interpolate a token or transaction contents. `.gitignore` excludes every `*.csv` and `*.pdf` except the fake files in `sample/`, so you can't commit your real data by accident.

One more honest limit: **the agent you connect decides what happens to the answers.** If the host sends tool results to a cloud model, those results (for example, a list of your transactions) go to that model's provider. This server keeps the files local; it can't control what a connected model does with what it is shown. For fully local use, connect it to a local model.

## Adding a bank

The design keeps this small. A bank is one file that answers two questions about a file's text — *is this yours?* and *what are the transactions?* — plus one line in a list.

1. Add the bank's id to `BankId` in [`src/types.ts`](src/types.ts).
2. Write `src/banks/<bank>.ts` exporting a `BankParser` (`detect` and `parse`, both plain functions of the file's text; throw `BankFormatError` when a recognised file can't be read). Return amounts as integer cents, positive for money out, negative for money back, and tag card-bill settlements `payment`.
3. Add it to `PARSERS` in [`src/banks/index.ts`](src/banks/index.ts).
4. Add a synthetic fixture and tests. Never commit a real statement.

Nothing else changes: the store, every tool, the Gmail sync and the privacy tests all go through the same `ingest()` path. If the bank prints totals, reconcile against them as the Itaú parser does.

## Development

```bash
npm test          # parsers, analytics, file loading, Gmail (against fakes), privacy rules, and end-to-end MCP sessions
npm run typecheck
npm run dev -- --dir sample
```

The end-to-end test starts the real server over stdio and talks to it with the official MCP client, the same way an agent host would. PDF tests build real PDF files from fake statement text, so the extraction path is exercised too. One test (symlink escape) is skipped on systems that don't allow creating symlinks, such as Windows without developer mode.

```
src/types.ts         shared types: Transaction, BankParser, ParseResult
src/parse.ts         bank-neutral helpers: CSV, dates, money (integer cents)
src/banks/           one module per bank + the registry (nubank.ts, itau.ts, index.ts)
src/pdf.ts           in-process PDF text extraction
src/ingest.ts        bytes -> text -> the parser that recognises it
src/store.ts         read-only loader: top-level .csv/.pdf only, path-escape guard, mtime cache
src/analytics.ts     summaries, month comparison, recurring-charge detection (pure functions)
src/server.ts        MCP tool definitions
src/index.ts         stdio entry point and CLI (including `auth`)
src/google/          optional Gmail and Drive: shared OAuth (auth.ts), REST clients and syncs
                     (gmail-api.ts, gmail-sync.ts, drive-api.ts, drive-sync.ts), one safe-save routine (save.ts)
sample/              synthetic invoices (not real data)
```

### Known limitations

- Recurring-charge detection is heuristic: one charge a month within ±5%. It misses subscriptions whose price changed and may flag a habit that happens to be regular.
- Categories are whatever the bank printed; Nubank's e-mailed card CSV has none, so those rows are `uncategorized`.
- Only BRL totals; foreign-currency purchases are kept in BRL with the original amount shown.
- Emailed Nubank statements are named after the invoice **due date**, so an invoice holds the previous month's purchases. Invoice `month` follows the due date; `monthly_totals` and `compare_months` group by transaction date, so the two views can differ.
- Itaú statements with several cards (additional cardholders) are read as one invoice; per-card breakdown is not exposed.
- Built for personal use on a handful of files, not as a financial-reporting tool.

## Built with AI assistance

Most of the code, tests and documentation in this repository were written by an AI assistant (Claude Code, by Anthropic), working from my requirements and constraints: read-only access, financial data stays local, the agent cannot change which mailbox query or Drive folder is read, and every parse must reconcile with the totals printed on the statement. I directed the design, supplied the real statements and accounts it was tested against, and ran it. Nubank and Itaú parsing was checked against my own real files (every Itaú statement adds up to its printed total), but that is a handful of files from one person, so **treat it as unreviewed software: read the code, and check `list_invoices`'s `check` field against your own statements before relying on any number.**

## License

MIT
