// Writing the published files.
//
// Two feeds, on purpose:
//
//   feed.json  what the dashboard fetches. Contract v1, capped at 200, and
//              carrying ONLY the contract's fields. `note` is a site-only field
//              and shipping it here is what pushes the payload past the ~50KB the
//              contract asks for — at 624 bytes/item, 200 items is 122KB, and
//              roughly 40% of that is a field the dashboard explicitly ignores.
//
//   site.json  what the reading room renders. Everything ever published, with the
//              notes, the images and the read-state. No cap: the site is the place
//              the rest of the pool lives.

import fs from "node:fs";
import path from "node:path";
import { FEED, ORIGIN, PATHS, TOPICS } from "./config.mjs";
import { editionDay } from "./day.mjs";

// The served files are minified: they are build artifacts fetched by machines and
// by one page, not things anyone reads in a diff. The archive stays pretty-printed,
// because that is the audit trail git history is actually for.
function writeJson(file, value, { pretty = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = pretty ? JSON.stringify(value, null, 2) + "\n" : JSON.stringify(value);
  fs.writeFileSync(file, body);
}

// Which edition an item sits under on the site. Melbourne, not UTC — see day.mjs.
const dayOf = (item) =>
  editionDay(item._homepage.published_at || item.date_published || "");

/**
 * Decide which archived items are live in the dashboard's feed.
 *
 * - `irrelevant` dismissals never appear anywhere again.
 * - `read` items stay on the site but leave the live feed; the dashboard has
 *   already dismissed them, so they are only taking up cap.
 * - evergreen ages out of the live feed after 90 days (interests.md rule 5) but
 *   stays on the site forever. A rated-up item is exempt: you said you wanted it.
 * - newest first, then hard-capped. Trim, never paginate.
 */
export function selectLive(archive, signals, now = new Date()) {
  const cutoff = now.getTime() - FEED.evergreenMaxAgeDays * 24 * 3600 * 1000;

  return archive
    .filter((item) => !signals.irrelevant.has(item.id))
    .filter((item) => !signals.read.has(item.id))
    .filter((item) => {
      if (item._homepage.kind !== "evergreen") return true;
      if (signals.interested && signals.interested.has(item.id)) return true;
      const published = Date.parse(item._homepage.published_at || item.date_published);
      return !Number.isFinite(published) || published >= cutoff;
    })
    .sort((a, b) =>
      String(b._homepage.published_at).localeCompare(String(a._homepage.published_at)),
    )
    .slice(0, FEED.cap);
}

/**
 * The dashboard's view. Contract fields only — no note, no image.
 *
 * One addition: `rated`. Read and dismissed items are already gone from the live
 * feed, so the only state the dashboard cannot otherwise see is a thumbs-up, and
 * without it the two surfaces disagree about an item the user has explicitly
 * rated. It is additive and optional — a v1 consumer ignores it — so the contract
 * version does not move.
 */
function leanItem(item, signals) {
  const out = {
    id: item.id,
    url: item.url,
    title: item.title,
    date_published: item.date_published,
    _homepage: {
      kind: item._homepage.kind,
      topic: item._homepage.topic,
      source: item._homepage.source,
    },
  };
  if (item.summary) out.summary = item.summary;
  if (signals && signals.interested && signals.interested.has(item.id)) {
    out._homepage.rated = "interested";
  }
  return out;
}

/** Build the dashboard's feed object. Pure — writes nothing, so tests can call it. */
export function buildFeed(liveItems, generated, signals, signalsProven = false) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: FEED.title,
    description: FEED.description,
    home_page_url: ORIGIN,
    feed_url: `${ORIGIN}/feed.json`,
    _homepage: {
      generated,
      // Published only when the run proved the whole loop: a synthetic signal
      // POSTed at the live endpoint and read back out of Redis. Advertising it
      // otherwise means the dashboard fires every dismissal into a wall and
      // swallows the failure by design, which is a total and silent loss. The
      // contract's own default — absent means keep signals local — is the correct
      // state until the round trip works.
      //
      // SIGNALS_ENABLED=0 forces it off regardless, as an escape hatch.
      ...(signalsProven && process.env.SIGNALS_ENABLED !== "0"
        ? { signals_url: `${ORIGIN}/api/signal` }
        : {}),
    },
    items: liveItems.map((item) => leanItem(item, signals)),
  };
}

export function writeFeed(liveItems, generated, signals, signalsProven = false) {
  const feed = buildFeed(liveItems, generated, signals, signalsProven);
  writeJson(PATHS.feed, feed);
  return feed;
}

/** Build the reading room's feed object. Pure — writes nothing. */
export function buildSite(archive, signals, generated) {
  const items = archive
    .filter((item) => !signals.irrelevant.has(item.id))
    .map((item) => ({
      ...item,
      _homepage: {
        ...item._homepage,
        read: signals.read.has(item.id),
        liked: signals.interested ? signals.interested.has(item.id) : false,
      },
    }))
    .sort((a, b) =>
      String(b._homepage.published_at).localeCompare(String(a._homepage.published_at)),
    );

  const site = {
    version: "https://jsonfeed.org/version/1.1",
    title: FEED.title,
    description: FEED.description,
    home_page_url: ORIGIN,
    feed_url: `${ORIGIN}/site.json`,
    _homepage: { generated, scope: "everything ever published" },
    items,
  };

  return site;
}

export function writeSite(archive, signals, generated) {
  const site = buildSite(archive, signals, generated);
  writeJson(PATHS.site, site);
  return site;
}

export function writeStatus(status) {
  writeJson(PATHS.status, status);
  return status;
}

/** Numbers for /status and for the run's own console summary. */
export function poolHealth(liveItems) {
  const timely = liveItems.filter((i) => i._homepage.kind === "timely").length;
  const topics = Object.fromEntries(
    TOPICS.map((t) => [t, liveItems.filter((i) => i._homepage.topic === t).length]),
  );
  return {
    total: liveItems.length,
    timely,
    evergreen: liveItems.length - timely,
    topics,
    meetsItemFloor: liveItems.length >= FEED.floorItems,
    meetsTimelyFloor: timely >= FEED.floorTimely,
  };
}

export { dayOf };
