// The archive: every item ever published, and the per-day record of what each run
// did. This is what makes "the site shows everything ever published" true — the
// live feed is capped at 200 and evergreen ages out of it, but nothing ever leaves
// the archive.
//
// Layout:
//   archive/all.json          every item ever published, oldest first
//   archive/index.json        run history — dates, counts, drops
//   archive/days/YYYY-MM-DD.json   one file per publish day, the audit trail

import fs from "node:fs";
import path from "node:path";
import { ARCHIVE, PATHS } from "./config.mjs";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** Every item ever published, oldest first. */
export function loadArchive() {
  const all = readJson(PATHS.archiveAll, null);
  if (Array.isArray(all)) return all;
  if (all && Array.isArray(all.items)) return all.items;
  return [];
}

export function loadIndex() {
  const index = readJson(PATHS.archiveIndex, null);
  return index && Array.isArray(index.runs) ? index : { runs: [] };
}

/** Ids already published. Rule 3 of the brief: an item published never returns. */
export function publishedIds(archive) {
  return new Set(archive.map((item) => item.id));
}

/**
 * Merge today's newly verified items into the archive.
 * Existing items are updated in place (an image found later, a redirect resolved)
 * but never duplicated and never re-dated — `published_at` is set once, ever.
 */
export function mergeIntoArchive(archive, fresh) {
  const byId = new Map(archive.map((item) => [item.id, item]));
  const added = [];

  for (const item of fresh) {
    const existing = byId.get(item.id);
    if (existing) {
      // Keep the original publish date; refresh everything else.
      byId.set(item.id, {
        ...existing,
        ...item,
        _homepage: {
          ...existing._homepage,
          ...item._homepage,
          published_at: existing._homepage.published_at,
        },
      });
    } else {
      byId.set(item.id, item);
      added.push(item);
    }
  }

  const merged = [...byId.values()].sort((a, b) =>
    String(a._homepage.published_at).localeCompare(String(b._homepage.published_at)),
  );

  return { archive: merged, added };
}

export function saveArchive(archive) {
  writeJson(PATHS.archiveAll, archive);
}

/** One file per publish day — the thing git history is actually auditing. */
export function saveDay(day, items, meta) {
  writeJson(PATHS.archiveDay(day), {
    day,
    ran_at: meta.ranAt,
    published: items.length,
    dropped: meta.dropped || [],
    items,
  });
}

export function saveIndex(index, run) {
  const runs = index.runs.filter((r) => r.day !== run.day);
  runs.push(run);
  runs.sort((a, b) => a.day.localeCompare(b.day));
  writeJson(PATHS.archiveIndex, { updated: new Date().toISOString(), runs });
  return { runs };
}

/**
 * Items published per day for the last `days` days, oldest first, zero-filled.
 * /status draws this as a bar chart, so gaps have to be real zeroes rather than
 * missing entries — a day the generator failed should look like a gap.
 */
export function perDay(index, days = 30) {
  const counts = new Map(index.runs.map((r) => [r.day, r.published || 0]));
  const out = [];
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(cursor.getTime() - i * 24 * 3600 * 1000);
    out.push(counts.get(d.toISOString().slice(0, 10)) || 0);
  }
  return out;
}

export function archiveDir() {
  return ARCHIVE;
}
