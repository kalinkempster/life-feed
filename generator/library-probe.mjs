#!/usr/bin/env node
// Inspect the record library as the generator sees it.
//
//   npm run library
//
// Use it after changing the Notion schema. A property renamed in Notion silently
// stops matching, and the first symptom is otherwise a run's worth of `records`
// items that ignore the collection entirely.

import { loadLibrary, digest } from "./lib/library.mjs";
import { ENV } from "./lib/config.mjs";

const library = await loadLibrary();

console.log(`\n  database  ${ENV.notionDb || "(not set)"}`);
console.log(
  library.error
    ? `  status    ${library.stale ? "STALE CACHE" : "FAILED"} — ${library.error}`
    : `  status    live read, ${library.records.length} records`,
);

if (!library.records.length) {
  console.log("\n  Nothing readable. Check NOTION_TOKEN, NOTION_LIBRARY_DB, and that");
  console.log("  the database is shared with the integration.\n");
  process.exit(1);
}

const blank = (field) => library.records.filter((r) => !r[field]).length;
const total = library.records.length;

console.log("\n  field coverage");
for (const field of ["artist", "title", "year", "genre", "vibes", "label", "plays"]) {
  const missing = blank(field);
  const have = total - missing;
  const flag = field === "artist" || field === "title" ? (missing ? "  ← PROBLEM" : "") : "";
  console.log(
    `    ${field.padEnd(8)} ${String(have).padStart(4)}/${total}` +
      ` (${Math.round((have / total) * 100)}%)${flag}`,
  );
}

console.log("\n  sample");
for (const r of library.records.slice(0, 3)) {
  console.log(`    ${r.artist} — ${r.title}${r.year ? ` (${r.year})` : ""}`);
}

const text = digest(library);
console.log(`\n  prompt digest: ${text.length} chars\n`);
console.log(text.split("\n").slice(0, 4).join("\n"));
console.log("");
