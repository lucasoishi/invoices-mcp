/**
 * End-to-end: start the real server over stdio and talk to it with the official MCP client,
 * exactly as an agent host (Claude Desktop, Cursor, ...) would.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleDir = path.join(root, "sample");

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

function connect(dir: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(root, "src", "index.ts"), "--dir", dir],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e-test", version: "0.0.0" });
  return { client, transport };
}

const json = (result: unknown) => JSON.parse((result as ToolResult).content[0]!.text);

describe("MCP server over stdio", () => {
  const { client, transport } = connect(sampleDir);
  before(async () => {
    await client.connect(transport);
  });
  after(async () => {
    await client.close();
  });

  it("advertises seven read-only tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "compare_months",
      "find_recurring_charges",
      "list_banks",
      "list_invoices",
      "monthly_totals",
      "search_transactions",
      "spending_summary",
    ]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
      assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} must not touch the network`);
    }
  });

  it("list_invoices returns the sample files", async () => {
    const data = json(await client.callTool({ name: "list_invoices", arguments: {} }));
    assert.equal(data.invoices.length, 5);
    assert.deepEqual(data.skippedFiles, []);
  });

  it("list_banks says exactly which banks are supported", async () => {
    const data = json(await client.callTool({ name: "list_banks", arguments: {} }));
    assert.deepEqual(
      data.banks.map((b: { id: string; formats: string[] }) => [b.id, b.formats]),
      [
        ["nubank", ["csv"]],
        ["itau", ["pdf"]],
      ],
    );
  });

  it("list_invoices confirms the Itaú statement adds up to its own printed total", async () => {
    const data = json(await client.callTool({ name: "list_invoices", arguments: { bank: "itau" } }));
    assert.equal(data.invoices.length, 1);
    const [inv] = data.invoices;
    assert.equal(inv.bank, "itau");
    assert.equal(inv.dueDate, "2026-10-01");
    assert.deepEqual(inv.check, { statementTotalBRL: 1650.7, parsedTotalBRL: 1650.7, matchesStatement: true });
    assert.equal(inv.netSpendBRL, 1650.7);
    assert.deepEqual(inv.warnings, []);
  });

  it("spending_summary can be limited to one bank", async () => {
    const itau = json(await client.callTool({ name: "spending_summary", arguments: { bank: "itau" } }));
    assert.deepEqual(itau.byBank.map((b: { bank: string }) => b.bank), ["itau"]);
    assert.equal(itau.netSpendBRL, 1650.7);
    const all = json(await client.callTool({ name: "spending_summary", arguments: {} }));
    assert.deepEqual(all.byBank.map((b: { bank: string }) => b.bank).sort(), ["itau", "nubank"]);
  });

  it("spending_summary matches the independent totals", async () => {
    const data = json(await client.callTool({ name: "spending_summary", arguments: { invoice: "2026-10" } }));
    assert.equal(data.spendBRL, 848.62);
    assert.equal(data.byCategory[0].category, "supermercado");
  });

  it("search_transactions filters and limits", async () => {
    const data = json(
      await client.callTool({
        name: "search_transactions",
        arguments: { query: "mercado", bank: "nubank", min_amount: 200, limit: 1 },
      }),
    );
    assert.equal(data.matchCount, 2); // 213.47 (Aug) and 240.10 (Oct) card purchases
    assert.equal(data.returned, 1);
    assert.equal(data.transactions[0].amountBRL, 240.1);
  });

  it("find_recurring_charges finds the subscriptions", async () => {
    const data = json(await client.callTool({ name: "find_recurring_charges", arguments: { bank: "nubank" } }));
    assert.deepEqual(data.recurring.map((r: { merchant: string }) => r.merchant).sort(), [
      "Academia Forma",
      "Cloud Armazenamento",
      "Streaming Plus",
    ]);
    assert.equal(data.totalMonthlyBRL, 169.79);
  });

  it("rejects malformed input instead of guessing", async () => {
    const result = (await client.callTool({
      name: "compare_months",
      arguments: { month_a: "September", month_b: "2026-10" },
    })) as ToolResult;
    assert.equal(result.isError, true);
  });

  it("returns a helpful error for an unknown invoice", async () => {
    const result = (await client.callTool({
      name: "spending_summary",
      arguments: { invoice: "1999-01" },
    })) as ToolResult;
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /list_invoices/);
  });
});

describe("MCP server with a bad folder", () => {
  it("answers with a clear error and does not crash", async () => {
    const { client, transport } = connect(path.join(sampleDir, "does-not-exist"));
    await client.connect(transport);
    try {
      const result = (await client.callTool({ name: "list_invoices", arguments: {} })) as ToolResult;
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /could not be read/);
    } finally {
      await client.close();
    }
  });
});
