#!/usr/bin/env node
// Check whether a candidate source is alive, and show what it has just published.
//
//   node generator/probe-sources.mjs candidates.txt
//   node generator/probe-sources.mjs --topic=melbourne
//
// Reads a list of "topic<TAB>Name<TAB>url" lines, finds each site's feed, and
// prints the three most recent posts with dates. A source that cannot be reached,
// has no feed, or has not published in months is not worth adding — this is how
// that gets decided on evidence rather than on the name being familiar.

import fs from "node:fs";
import { USER_AGENT } from "./lib/config.mjs";

const TIMEOUT = 20000;
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const only = (args.find((a) => a.startsWith("--topic=")) || "").split("=")[1];

async function get(url, accept) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: control.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept || "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
      },
    });
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    return { ok: true, status: res.status, text: await res.text(), url: res.url };
  } catch (err) {
    return { ok: false, status: err.name === "AbortError" ? "timeout" : "net", text: "" };
  } finally {
    clearTimeout(timer);
  }
}

const strip = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&#8217;|&#039;|&apos;/g, "'")
    .replace(/&#8216;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#8211;|&ndash;/g, "–").replace(/&#8212;|&mdash;/g, "—")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** Find a feed: the declared one, then the usual suspects. */
async function findFeed(siteUrl) {
  const home = await get(siteUrl);
  if (home.ok) {
    const tags = home.text.match(/<link[^>]+>/gi) || [];
    for (const tag of tags) {
      if (!/type\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(tag)) continue;
      const href = tag.match(/href\s*=\s*["']([^"']+)["']/i);
      if (href) {
        try {
          return new URL(strip(href[1]), home.url || siteUrl).toString();
        } catch { /* keep looking */ }
      }
    }
  }
  for (const guess of ["/feed", "/feed/", "/rss", "/rss.xml", "/index.xml", "/atom.xml", "/feed.xml"]) {
    try {
      const candidate = new URL(guess, siteUrl).toString();
      const res = await get(candidate, "application/rss+xml,application/atom+xml,*/*");
      if (res.ok && /<(rss|feed|rdf:RDF)[\s>]/i.test(res.text)) return candidate;
    } catch { /* next */ }
  }
  return null;
}

function parseEntries(xml, limit = 3) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.slice(0, limit).map((b) => {
    const title = strip((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    const date =
      (b.match(/<(pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || "";
    const parsed = Date.parse(strip(date));
    return { title, date: Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "—" };
  });
}

/** Last-resort headline scrape for sites with no feed. */
function headlinesFrom(html) {
  const seen = new Set();
  const out = [];
  // Prefer headings that wrap a link — that is what an index page's article
  // titles almost always look like.
  const re = /<h[1-3][^>]*>\s*(?:<a[^>]*>)?([\s\S]{4,160}?)(?:<\/a>)?\s*<\/h[1-3]>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 3) {
    const title = strip(m[1]);
    if (title.length < 12 || title.length > 120) continue;
    if (/^(menu|search|newsletter|subscribe|follow|share|categories|shop|cart)$/i.test(title)) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ title, date: "—" });
  }
  return out;
}

const lines = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const [topic, name, url] = l.split("\t").map((x) => x.trim());
    return { topic, name, url };
  })
  .filter((c) => !only || c.topic === only);

const results = [];
const queue = [...lines];

async function worker() {
  while (queue.length) {
    const c = queue.shift();
    const feed = await findFeed(c.url);
    if (!feed) {
      // No feed is not disqualifying: the curator finds things with WebSearch, not
      // RSS. Fall back to reading headlines off the homepage so recency can still
      // be judged.
      const home = await get(c.url);
      const entries = home.ok ? headlinesFrom(home.text) : [];
      results.push({
        ...c,
        status: entries.length ? "no feed — homepage headlines" : "unreachable",
        entries,
      });
      continue;
    }
    const res = await get(feed, "application/rss+xml,application/atom+xml,*/*");
    if (!res.ok) {
      results.push({ ...c, status: `feed ${res.status}`, entries: [], feed });
      continue;
    }
    const entries = parseEntries(res.text);
    results.push({ ...c, status: entries.length ? "ok" : "feed empty", entries, feed });
  }
}

await Promise.all(Array.from({ length: 6 }, worker));

results.sort((a, b) => a.topic.localeCompare(b.topic) || a.name.localeCompare(b.name));

let topic = null;
for (const r of results) {
  if (r.topic !== topic) {
    topic = r.topic;
    console.log(`\n\n### ${topic.toUpperCase()}`);
  }
  const newest = r.entries[0]?.date || "—";
  console.log(`\n${r.name}  —  ${r.url}`);
  console.log(`  ${r.status}${r.status === "ok" ? `, latest ${newest}` : ""}`);
  for (const e of r.entries) console.log(`   · ${e.date}  ${e.title.slice(0, 96)}`);
}

const live = results.filter((r) => r.status === "ok").length;
console.log(`\n\n${live} of ${results.length} candidate sources are live and publishing.`);
