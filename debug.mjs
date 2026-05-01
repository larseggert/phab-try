#!/usr/bin/env node
/**
 * Minimal debug wrapper — loads background.js and calls doFetch directly.
 * background.js source is a static local file (not user input), so the
 * Function constructor is safe here.
 *
 * Usage:
 *   node debug.mjs <D-number> [author-email]
 *
 * Examples:
 *   node debug.mjs 291709 leggert@mozilla.com
 *   node debug.mjs D291709
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "background.js"), "utf8");

// Minimal stubs for the browser APIs background.js uses at load time
const browser = {
  storage: { sync: { get: async () => ({}) } },
  runtime: { onMessage: { addListener: () => {} } },
};

// Execute background.js in a controlled scope and extract doFetch.
// The source is a static local file, not user-supplied input.
// eslint-disable-next-line no-new-func
const { doFetch } = new Function("browser", `${src}\nreturn { doFetch };`)(browser);

const [, , rawD, author] = process.argv;
if (!rawD) {
  console.error("Usage: node debug.mjs <D-number> [email]");
  process.exit(1);
}
const dNumber = rawD.replace(/^D/i, "");

const { pushes } = await doFetch(author ?? null, dNumber, null, "debug");

console.log(`\n${pushes.length} push(es) for D${dNumber}:`);
for (const p of pushes)
  console.log(
    `  ${p.revision.slice(0, 12)}  ${new Date(p.push_timestamp * 1000).toISOString()}  ${p.author}`,
  );
if (!pushes.length) console.log("  (none)");
