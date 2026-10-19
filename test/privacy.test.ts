/**
 * The promise of this project: by default it is read-only, local and silent; the optional Google
 * sources (Gmail, Drive) are the single, fenced-off exception, and they live in src/google/.
 * These tests make that promise executable: if someone adds a network call, a file write or a
 * log line in the wrong place, the build fails.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".ts") ? [{ file: path.relative(srcDir, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") }] : [];
  });
}

const all = walk(srcDir);
const google = all.filter((s) => s.file.startsWith("google/"));
const core = all.filter((s) => !s.file.startsWith("google/"));
const file = (name: string) => google.find((s) => s.file === `google/${name}`)!;

const FORBIDDEN: [string, RegExp][] = [
  ["network: http/https/http2", /node:https?['"]|node:http2['"]|from ['"]https?['"]/],
  ["network: net/tls/dgram/dns", /node:(net|tls|dgram|dns)['"]/],
  ["network: fetch / WebSocket / XMLHttpRequest", /\bfetch\s*\(|\bWebSocket\b|XMLHttpRequest/],
  ["processes: child_process", /child_process/],
  ["writes: file writes", /\b(writeFile|appendFile|createWriteStream|writeFileSync|appendFileSync|unlink|rm|rmdir|rename|copyFile|mkdir)\s*\(/],
];

describe("core (everything outside src/google) stays read-only and offline", () => {
  for (const [label, pattern] of FORBIDDEN) {
    it(`never uses ${label}`, () => {
      for (const { file, text } of core) {
        assert.ok(!pattern.test(text), `${file} matches a forbidden pattern: ${label}`);
      }
    });
  }

  it("only loads the Google code lazily or as types", () => {
    for (const { file, text } of core) {
      assert.ok(
        !/^import (?!type)[^;]*from ["']\.\/google\//m.test(text),
        `${file} statically imports ./google/: it must be a dynamic import() or a type import`,
      );
    }
  });
});

describe("the Google modules are narrow", () => {
  const allowedHosts = new Set([
    "accounts.google.com", // sign-in page the user opens
    "oauth2.googleapis.com", // token endpoint
    "gmail.googleapis.com", // Gmail REST API
    "www.googleapis.com", // Drive REST API, and the scope identifier strings
    "127.0.0.1", // loopback redirect for the one-time sign-in
  ]);

  it("only talks to Google (and loopback)", () => {
    for (const { file, text } of google) {
      for (const [url] of text.matchAll(/https?:\/\/[^\s"'`)\\]+/g)) {
        const host = new URL(url.replace(/\$\{[^}]*\}.*/, "")).hostname;
        assert.ok(allowedHosts.has(host), `${file} references an unexpected host: ${host}`);
      }
    }
  });

  it("uses www.googleapis.com only for scope names and the Drive files endpoint", () => {
    for (const { file, text } of google) {
      for (const [url] of text.matchAll(/https:\/\/www\.googleapis\.com[^\s"'`)\\]*/g)) {
        assert.ok(
          /^https:\/\/www\.googleapis\.com\/(auth\/(gmail|drive)\.readonly|drive\/v3\/files)$/.test(url.replace(/\$\{[^}]*\}.*/, "")),
          `${file} references an unexpected googleapis.com URL: ${url}`,
        );
      }
    }
  });

  it("only ever asks for the two read-only scopes", () => {
    const scopes = google.flatMap(({ text }) => [...text.matchAll(/auth\/(?:gmail|drive)[.\w]*/g)].map((m) => m[0]));
    assert.ok(scopes.length >= 2);
    assert.deepEqual([...new Set(scopes)].sort(), ["auth/drive.readonly", "auth/gmail.readonly"]);
  });

  it("makes no request that changes a mailbox or a Drive", () => {
    for (const { file, text } of google) {
      assert.ok(!/method:\s*["'](DELETE|PUT|PATCH)["']/.test(text), `${file} uses a mutating HTTP method`);
      // "myaccount.google.com/permissions" is the page where a person revokes access, mentioned in a help message.
      const withoutHelpLinks = text.replace(/myaccount\.google\.com\/permissions/g, "");
      assert.ok(
        !/\/(trash|delete|modify|send|batchModify|batchDelete|copy|permissions|emptyTrash|watch|update)\b/.test(withoutHelpLinks),
        `${file} references a mutating Gmail or Drive endpoint`,
      );
    }
  });

  it("the Gmail and Drive API clients send nothing but GET requests", () => {
    // fetch() defaults to GET; any `method:` option in these two files would be a change of that.
    for (const name of ["gmail-api.ts", "drive-api.ts"]) {
      assert.ok(!/\bmethod\s*:/.test(file(name).text), `${name} sets an HTTP method`);
      assert.ok(!/\bbody\s*:/.test(file(name).text), `${name} sends a request body`);
    }
  });

  it("does not run other programs", () => {
    for (const { file, text } of google) assert.ok(!/child_process/.test(text), `${file} spawns a process`);
  });

  it("writes files only through the shared safe-save helper (and the token file)", () => {
    for (const { file, text } of google) {
      if (["google/save.ts", "google/auth.ts"].includes(file)) continue;
      // sync modules may create the destination folder, but must not write files themselves
      assert.ok(!/\b(writeFile|appendFile|createWriteStream|copyFile|rename|unlink|rm)\s*\(/.test(text), `${file} writes a file itself`);
    }
  });
});

describe("logging", () => {
  it("never logs through console", () => {
    assert.deepEqual(all.filter(({ text }) => /console\.(log|error|warn|info)/.test(text)).map((s) => s.file), []);
  });

  it("never writes transaction data or secrets to stderr", () => {
    // process.stderr.write is used for status lines only. Look at what is interpolated into each
    // one: a token file's *path* is fine, but never a token, a secret, or transaction contents.
    for (const { file, text } of all) {
      for (const [line] of text.matchAll(/process\.stderr\.write\([^;]*\);/g)) {
        for (const [, expression] of line.matchAll(/\$\{([^}]*)\}/g)) {
          const expr = expression!.replace(/tokenPath/g, "");
          assert.ok(
            !/token|secret|refresh|access|password|\.description|\.merchant|transactions?\b/i.test(expr),
            `${file} interpolates something sensitive into stderr: \${${expression}}`,
          );
        }
      }
    }
  });
});
