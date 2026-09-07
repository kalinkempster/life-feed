// Paths, constants and environment. Everything else imports from here so there is
// exactly one place that knows where things live.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "..", "..");
export const SITE = path.join(ROOT, "site");
export const ARCHIVE = path.join(ROOT, "archive");
export const CURATION = path.join(ROOT, "curation");

export const PATHS = {
  feed: path.join(SITE, "feed.json"), // lean — what the dashboard fetches
  site: path.join(SITE, "site.json"), // full — what the reading room renders
  status: path.join(SITE, "status.json"),
  archiveAll: path.join(ARCHIVE, "all.json"),
  archiveIndex: path.join(ARCHIVE, "index.json"),
  archiveDay: (day) => path.join(ARCHIVE, "days", `${day}.json`),
  interests: path.join(CURATION, "interests.md"),
  sources: path.join(CURATION, "sources.md"),
  library: path.join(CURATION, "library.md"),
  libraryCache: path.join(CURATION, ".library-cache.json"),
};

// The public origin. Everything self-referential in the feed is built from this,
// so there is one string to change if the domain ever moves.
export const ORIGIN = (process.env.SITE_ORIGIN || "https://life-of-kk.vercel.app")
  .replace(/\/+$/, "");

export const FEED = {
  title: "Life of K²",
  description: "Circulation: one. Standards: unreasonable.",
  cap: 200, // contract: hard cap on items in feed.json
  floorItems: 40, // contract: keep at least this many undismissed live
  floorTimely: 15, // contract: of which at least this many timely
  evergreenMaxAgeDays: 90, // interests.md rule 5: evergreen ages out of the live feed
};

// Canonical topic keys. Adding one is a contract change: the dashboard uses topic
// to enforce variety, so it has to learn a new key before the feed emits it.
// `news` was added 2026-09-07 — see the amendment in uploads/feed-contract.md.
export const TOPICS = [
  "medicine",
  "news",
  "records",
  "photography",
  "fashion",
  "gaming",
  "melbourne",
  "other",
];

export const KINDS = ["timely", "evergreen"];

// A real browser UA. Sending the default Node UA gets 403s from Cloudflare-fronted
// sources (LITFL, GamesHub, TheGamer all block it) and a naive verifier reads those
// as dead links and drops perfectly good articles.
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const ENV = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  notionToken: process.env.NOTION_TOKEN || "",
  notionDb: process.env.NOTION_LIBRARY_DB || "",
  redisUrl: (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, ""),
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",
};

export const MODEL = "claude-opus-5";

// Redis keys. Three of them, deliberately: two sets and one hash.
export const KEYS = {
  read: "signals:read",
  irrelevant: "signals:irrelevant",
  interested: "signals:interested",
  meta: "signals:meta",
};
