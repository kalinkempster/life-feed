// The record library, read from Notion at the start of every run.
//
// The library is what makes the `records` topic worth anything: an artist in the
// collection is a strong signal, a reissue of something not in it is weak. Per
// curation/library.md, a failed Notion read falls back to the last good snapshot
// and reports the staleness on /status — it never silently skips the topic.
//
// The schema matters here. In this workspace the `Vinyls` database stores the
// artist as a RELATION to a separate `Artists` database, not as text. Reading the
// property naively returns an empty string for every row, which would leave the
// curator with 297 untitled records and no idea who is in the collection. So
// relations are resolved: the schema is read first, each related database is
// queried once, and the ids are mapped to titles.

import fs from "node:fs";
import path from "node:path";
import { ENV, PATHS } from "./config.mjs";

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

const headers = () => ({
  Authorization: `Bearer ${ENV.notionToken}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
});

async function notion(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, { ...init, headers: headers() });
  if (!res.ok) {
    throw new Error(`notion ${res.status} ${pathname}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

const titleOf = (page) => {
  const prop = Object.values(page.properties || {}).find((p) => p.type === "title");
  return prop ? (prop.title || []).map((t) => t.plain_text).join("").trim() : "";
};

async function queryAll(databaseId) {
  const out = [];
  let cursor;
  do {
    const page = await notion(`/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });
    out.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * Build id → title for every database this one relates to.
 * One query per related database rather than one request per row: 297 rows with a
 * relation each would otherwise be 297 round trips.
 */
async function resolveRelations(schema) {
  const map = new Map();
  const relatedIds = new Set();

  for (const prop of Object.values(schema.properties || {})) {
    if (prop.type === "relation" && prop.relation?.database_id) {
      relatedIds.add(prop.relation.database_id);
    }
  }

  for (const id of relatedIds) {
    try {
      for (const page of await queryAll(id)) {
        map.set(page.id, titleOf(page));
      }
    } catch {
      // A related database the integration cannot see is not fatal; the rows
      // simply resolve to nothing and the fallback below picks up the slack.
    }
  }

  return map;
}

function plain(property, relations) {
  if (!property) return "";
  switch (property.type) {
    case "title":
      return (property.title || []).map((t) => t.plain_text).join("").trim();
    case "rich_text":
      return (property.rich_text || []).map((t) => t.plain_text).join("").trim();
    case "select":
      return property.select ? property.select.name : "";
    case "status":
      return property.status ? property.status.name : "";
    case "multi_select":
      return (property.multi_select || []).map((s) => s.name).join(", ");
    case "number":
      return property.number == null ? "" : String(property.number);
    case "url":
      return property.url || "";
    case "date":
      return property.date?.start || "";
    case "relation":
      return (property.relation || [])
        .map((r) => relations.get(r.id))
        .filter(Boolean)
        .join(", ");
    case "rollup":
      if (property.rollup?.type === "number") return String(property.rollup.number ?? "");
      if (property.rollup?.type === "array") {
        return (property.rollup.array || [])
          .map((entry) => plain(entry, relations))
          .filter(Boolean)
          .join(", ");
      }
      return "";
    case "formula":
      return String(
        property.formula?.string ??
          property.formula?.number ??
          property.formula?.boolean ??
          "",
      );
    default:
      return "";
  }
}

// Notion property names vary by database; match on intent rather than exact label.
function pick(properties, patterns, relations) {
  for (const [name, value] of Object.entries(properties || {})) {
    if (patterns.some((re) => re.test(name))) {
      const text = plain(value, relations);
      if (text) return text;
    }
  }
  return "";
}

function toRecord(page, relations) {
  const props = page.properties || {};
  const artist = pick(props, [/artist/i, /^band$/i], relations);
  const title = pick(props, [/^(album|record|title|name)$/i, /album/i], relations);
  const label = pick(props, [/label/i], relations);
  const year = pick(props, [/year/i, /released/i, /release\s*date/i], relations);
  const genre = pick(props, [/genre/i], relations);
  const vibes = pick(props, [/vibe/i, /mood/i], relations);
  const plays = pick(props, [/play\s*count/i], relations);

  if (!artist && !title) return null;
  return { artist, title, label, year, genre, vibes, plays };
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
    const schema = await notion(`/databases/${ENV.notionDb}`);
    const relations = await resolveRelations(schema);
    const pages = await queryAll(ENV.notionDb);
    const records = pages.map((p) => toRecord(p, relations)).filter(Boolean);

    if (!records.length) throw new Error("database returned no readable rows");

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

const uniq = (values) => [...new Set(values.filter(Boolean))];

/** A compact digest for the prompt. Artists are the signal the brief actually uses. */
export function digest(library, limit = 400) {
  if (!library.records.length) return "(library unavailable this run)";

  // One row can credit several artists; split so collaborations count for both.
  const artists = uniq(library.records.flatMap((r) => r.artist.split(",").map((a) => a.trim())));
  const labels = uniq(library.records.map((r) => r.label));
  const genres = uniq(library.records.map((r) => r.genre));

  const mostPlayed = library.records
    .filter((r) => Number(r.plays) > 0)
    .sort((a, b) => Number(b.plays) - Number(a.plays))
    .slice(0, 20)
    .map((r) => `${r.artist} — ${r.title}`);

  return [
    `${library.records.length} records by ${artists.length} artists.`,
    library.stale && library.fetched
      ? `NOTE: cached snapshot from ${library.fetched}, not a live read.`
      : "",
    "",
    `Artists owned: ${artists.slice(0, limit).join(" · ")}`,
    genres.length ? `\nGenres in the collection: ${genres.join(" · ")}` : "",
    labels.length ? `\nLabels owned: ${labels.slice(0, 120).join(" · ")}` : "",
    mostPlayed.length ? `\nMost played:\n  ${mostPlayed.join("\n  ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
