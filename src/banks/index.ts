/**
 * The bank registry. To add a bank:
 *   1. add its id to `BankId` in ../types.ts
 *   2. write src/banks/<bank>.ts exporting a `BankParser` (detect + parse, both pure functions of the text)
 *   3. add it to PARSERS below
 * Nothing else changes: the store, tools and Gmail sync all go through `ingest()`.
 *
 * Banks that are not here yet are simply not recognised; their files are reported as skipped.
 */
import type { BankParser } from "../types.js";
import { itau } from "./itau.js";
import { nubank } from "./nubank.js";

export const PARSERS: readonly BankParser[] = [nubank, itau];

export function supportedBanks() {
  return PARSERS.map((p) => ({ id: p.id, name: p.name, formats: p.formats, description: p.description }));
}

export function describeSupport(): string {
  return PARSERS.map((p) => `${p.name} (${p.formats.map((f) => f.toUpperCase()).join("/")})`).join(", ");
}
