// The record library, read from Notion at the start of every run.
//
// The library is what makes the `records` topic worth anything: an artist in the
// collection is a strong signal, a reissue of something not in it is weak. Per
// curation/library.md, a failed Notion read falls back to the last good snapshot
// and reports the staleness on /status — it never silently skips the topic.

import fs from "node:fs";
import path from "node:path";
import { ENV, PATHS } from "./config.mjs";

const NOTION_VERSION = "2022-06-28";

function plain(property) {
  if (!property) return "";
  switch (property.type) {
    case "title":
      return (property.title || []).map((t) => t.plain_text).join("").trim();
    case "rich_text":
      return (property.rich_text || []).map((t) => t.plain_text).join("").trim();
    case "select":
      return property.select ? property.select.name : "";
    case "multi_select":
      return (property.multi_select || []).map((s) => s.name).join(", ");
    case "number":
      return property.number == null ? "" : String(property.number);
    case "url":
      return property.url || "";
    default:
      return "";
  }
}

// Notion property names vary by database; match on intent rather than exact label.
function pick(properties, patterns) {
  for (const [name, value] of Object.entries(properties || {})) {
    if (patterns.some((re) => re.test(name))) {
      const text = plain(value);
      if (text) return text;
    }
  }
  return "";
}

function toRecord(page) {
  const props = page.properties || {};
  const artist = pick(props, [/artist/i, /^band$/i]);
  const title = pick(props, [/^(album|record|title|name)$/i, /album/i, /title/i]);
  const label = pick(props, [/label/i]);
  const year = pick(props, [/year/i, /released/i, /date/i]);
  const genre = pick(props, [/genre/i, /style/i]);
  if (!artist && !title) return null;
  return { artist, title, label, year, genre };
}

async function fetchAllPages() {
  const results = [];
  let cursor;

  do {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${ENV.notionDb}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.notionToken}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
      },
    );

    if (!res.ok) {
      throw new Error(`notion ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const page = await res.json();
    results.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return results;
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.libraryCache, "utf8"));
    return raw && Array.isArray(raw.records) ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(records) {
  fs.mkdirSync(path.dirname(PATHS.libraryCache), { recursive: true });
  fs.writeFileSync(
    PATHS.libraryCache,
    JSON.stringify({ fetched: new Date().toISOString(), records }, null, 2),
  );
}

/**
 * @returns {Promise<{records:object[], stale:boolean, fetched:string|null, error:string|null}>}
 */
export async function loadLibrary() {
  if (!ENV.notionToken || !ENV.notionDb) {
    const cached = readCache();
    return {
      records: cached ? cached.records : [],
      stale: Boolean(cached),
      fetched: cached ? cached.fetched : null,
      error: "NOTION_TOKEN/NOTION_LIBRARY_DB not set",
    };
  }

  try {
    const pages = await fetchAllPages();
    const records = pages.map(toRecord).filter(Boolean);
    writeCache(records);
    return { records, stale: false, fetched: new Date().toISOString(), error: null };
  } catch (err) {
    const cached = readCache();
    return {
      records: cached ? cached.records : [],
      stale: true,
      fetched: cached ? cached.fetched : null,
      error: String(err.message || err),
    };
  }
}

/** A compact digest for the prompt — artists and labels are what the brief uses. */
export function digest(library, limit = 400) {
  if (!library.records.length) return "(library unavailable this run)";

  const artists = [...new Set(library.records.map((r) => r.artist).filter(Boolean))];
  const labels = [...new Set(library.records.map((r) => r.label).filter(Boolean))];

  return [
    `${library.records.length} records in the collection.`,
    library.stale && library.fetched
      ? `NOTE: this is a cached snapshot from ${library.fetched}, not a live read.`
      : "",
    "",
    `Artists owned (${artists.length}): ${artists.slice(0, limit).join(" · ")}`,
    labels.length ? `Labels owned: ${labels.slice(0, 120).join(" · ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
