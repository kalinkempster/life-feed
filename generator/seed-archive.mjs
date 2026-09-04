#!/usr/bin/env node
// One-off: seed the archive from the feed.json that existed before the archive did.
//
// Re-verifies every link and backfills the og:image that was never fetched, then
// writes archive/all.json, the per-day files and the run index. Safe to re-run —
// it merges rather than overwrites, and ids are unchanged by construction.

import fs from "node:fs";
import { PATHS } from "./lib/config.mjs";
import { assertIdsStable } from "./lib/url.mjs";
import { editionDay } from "./lib/day.mjs";
import { verifyAll } from "./lib/verify.mjs";
import {
  loadArchive,
  loadIndex,
  mergeIntoArchive,
  saveArchive,
  saveDay,
  saveIndex,
} from "./lib/archive.mjs";

const source = JSON.parse(fs.readFileSync(PATHS.feed, "utf8"));
const items = source.items || [];

console.log(`\n  seeding archive from ${items.length} existing items\n`);
assertIdsStable(items);
console.log("  ids        all stable — safe to adopt as-is");

console.log("  verifying  re-checking links and fetching og:images…");
const results = await verifyAll(
  items.map((i) => ({ url: i.url, item: i })),
  { concurrency: 5 },
);

const seeded = [];
const dropped = [];

for (const { candidate, check, image, icon } of results) {
  const item = candidate.item;
  if (check.status === "dead") {
    dropped.push({ code: check.code, url: item.url, when: "seed" });
    console.log(`    dropped ${check.code}  ${item.url}`);
    continue;
  }
  seeded.push({
    ...item,
    _homepage: {
      ...item._homepage,
      image: image || item._homepage.image || null,
      icon: icon || item._homepage.icon || null,
      ...(check.status === "inconclusive" ? { verified: "bot-walled" } : {}),
    },
  });
}

console.log(
  `  verified   ${seeded.length} kept · ${dropped.length} dropped · ` +
    `${seeded.filter((i) => i._homepage.image).length} images found`,
);

const merged = mergeIntoArchive(loadArchive(), seeded);
assertIdsStable(merged.archive);
saveArchive(merged.archive);

// Group into the days they were originally published on.
const byDay = new Map();
for (const item of merged.archive) {
  const day = editionDay(item._homepage.published_at || item.date_published);
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(item);
}

let index = loadIndex();
for (const [day, dayItems] of [...byDay.entries()].sort()) {
  saveDay(day, dayItems, { ranAt: `${day}T09:00:00Z`, dropped: [] });
  index = saveIndex(index, {
    day,
    ran_at: `${day}T09:00:00Z`,
    published: dayItems.length,
    dropped: 0,
    searches: 0,
    ok: true,
    seeded: true,
  });
}

console.log(`\n  archive    ${merged.archive.length} items across ${byDay.size} days`);
console.log(`  wrote      archive/all.json, archive/index.json, archive/days/*.json\n`);
