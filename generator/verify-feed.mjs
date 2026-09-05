#!/usr/bin/env node
// Contract conformance check. Run it against the published files before a deploy,
// or against the live site with --live. Exits non-zero on any hard failure, so it
// works as a CI gate.
//
//   npm run verify
//   node generator/verify-feed.mjs --live
//   node generator/verify-feed.mjs --links     (also re-checks every URL resolves)

import fs from "node:fs";
import { FEED, ORIGIN, PATHS, TOPICS, KINDS } from "./lib/config.mjs";
import { idFor } from "./lib/url.mjs";
import { verifyAll } from "./lib/verify.mjs";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const LINKS = args.includes("--links");

const failures = [];
const warnings = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);

async function load(name, file) {
  if (LIVE) {
    const res = await fetch(`${ORIGIN}/${name}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${name} returned ${res.status}`);
    return { data: await res.json(), bytes: Number(res.headers.get("content-length") || 0), res };
  }
  const raw = fs.readFileSync(file, "utf8");
  return { data: JSON.parse(raw), bytes: Buffer.byteLength(raw), res: null };
}

function checkFeed(feed, bytes) {
  if (feed.version !== "https://jsonfeed.org/version/1.1") {
    fail(`version must be exactly the JSON Feed 1.1 string, got ${feed.version}`);
  }
  if (feed.feed_url !== `${ORIGIN}/feed.json`) {
    fail(`feed_url is ${feed.feed_url} — must be the canonical self-reference ${ORIGIN}/feed.json`);
  }
  if (feed.home_page_url !== ORIGIN) {
    fail(`home_page_url is ${feed.home_page_url} — must be ${ORIGIN}`);
  }
  if (!feed._homepage || !feed._homepage.generated) {
    fail("_homepage.generated is required — a stalled generator must be visible");
  } else if (!Number.isFinite(Date.parse(feed._homepage.generated))) {
    fail(`_homepage.generated is not ISO 8601: ${feed._homepage.generated}`);
  }

  const items = feed.items || [];
  if (!Array.isArray(items)) fail("items must be an array");
  if (items.length > FEED.cap) fail(`${items.length} items exceeds the cap of ${FEED.cap}`);

  const ids = new Set();
  let timely = 0;

  for (const item of items) {
    const where = item.url || item.id || "<unknown>";

    if (!/^[0-9a-f]{64}$/.test(String(item.id || ""))) {
      fail(`id is not a hex SHA-256: ${where}`);
    } else {
      let expected = null;
      try {
        expected = idFor(item.url);
      } catch {
        fail(`url is not parseable: ${where}`);
      }
      if (expected && expected !== item.id) {
        fail(`id does not match sha256(normalised url) — dismissals will break: ${where}`);
      }
    }

    if (ids.has(item.id)) fail(`duplicate id: ${where}`);
    ids.add(item.id);

    if (!/^https:\/\//.test(String(item.url || ""))) fail(`url must be absolute HTTPS: ${where}`);
    if (!item.title) fail(`title is required: ${where}`);
    if (item.title && item.title.length > 70) {
      warn(`title is ${item.title.length} chars (renders at two lines up to ~70): ${item.title}`);
    }
    if (!Number.isFinite(Date.parse(item.date_published || ""))) {
      fail(`date_published is not ISO 8601: ${where}`);
    }

    const h = item._homepage || {};
    if (!KINDS.includes(h.kind)) fail(`_homepage.kind must be timely|evergreen: ${where}`);
    if (!TOPICS.includes(h.topic)) fail(`_homepage.topic is not canonical: ${h.topic} — ${where}`);
    if (!h.source) fail(`_homepage.source is required: ${where}`);
    if (h.source && h.source.length > 18) {
      warn(`source is ${h.source.length} chars (kicker fits ~18): ${h.source}`);
    }
    if (h.note !== undefined) {
      fail(`_homepage.note is site-only and must not ship in feed.json: ${where}`);
    }
    if (h.kind === "timely") timely += 1;
  }

  if (items.length < FEED.floorItems) {
    warn(`pool is ${items.length}, floor is ${FEED.floorItems} undismissed items`);
  }
  if (timely < FEED.floorTimely) {
    warn(`timely pool is ${timely}, floor is ${FEED.floorTimely}`);
  }

  const kb = bytes / 1024;
  if (kb > 60) warn(`feed.json is ${kb.toFixed(1)}KB — the contract targets around 50KB`);

  return { items, timely, kb };
}

async function main() {
  console.log(`\n  Contract v1 check — ${LIVE ? `live: ${ORIGIN}` : "local files"}\n`);

  const { data: feed, bytes } = await load("feed.json", PATHS.feed);
  const { items, timely, kb } = checkFeed(feed, bytes);

  console.log(`  feed.json    ${items.length} items · ${timely} timely · ${kb.toFixed(1)}KB`);

  if (feed._homepage?.signals_url) {
    // Synthetic id, and it is retracted immediately. Before the store existed this
    // POST went nowhere and the cleanup did not matter; now it does — every live
    // check was leaving a phantom "read" in Redis, inflating /status and showing
    // up as a signal nobody sent.
    const probeId = "0".repeat(64);
    const post = (body) =>
      fetch(feed._homepage.signals_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);

    const res = await post({ id: probeId, reason: "read" });
    await post({ id: probeId, reason: "clear" });

    if (!res || res.status !== 202) {
      fail(
        `signals_url is published but ${
          res ? `returns ${res.status}` : "is unreachable"
        } — the dashboard would fire every dismissal into a wall. ` +
          `Remove the key until the endpoint answers 202.`,
      );
    } else {
      console.log(`  signals_url  202, live`);
    }
  } else {
    console.log(`  signals_url  absent (dashboard keeps dismissals local)`);
  }

  try {
    const { data: site } = await load("site.json", PATHS.site);
    console.log(`  site.json    ${(site.items || []).length} items`);
  } catch (err) {
    warn(`site.json not readable: ${err.message}`);
  }

  if (LINKS) {
    console.log(`\n  re-checking ${items.length} links…`);
    const results = await verifyAll(
      items.map((i) => ({ url: i.url })),
      { concurrency: 5, withImages: false },
    );
    for (const { candidate, check } of results) {
      if (check.status === "dead") fail(`dead link ${check.code}: ${candidate.url}`);
      else if (check.status === "inconclusive") {
        warn(`bot-walled ${check.code} (not proof of a dead link): ${candidate.url}`);
      }
    }
    const dead = results.filter((r) => r.check.status === "dead").length;
    console.log(`  links        ${results.length - dead}/${results.length} resolve`);
  }

  if (warnings.length) {
    console.log(`\n  ${warnings.length} warning(s):`);
    warnings.forEach((w) => console.log(`    · ${w}`));
  }

  if (failures.length) {
    console.log(`\n  ${failures.length} FAILURE(S):`);
    failures.forEach((f) => console.log(`    ✗ ${f}`));
    console.log("");
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ✓ conforms to contract v1\n`);
}

main().catch((err) => {
  console.error(`\n  check failed to run: ${err.message}\n`);
  process.exitCode = 1;
});
