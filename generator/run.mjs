#!/usr/bin/env node
// The daily run.
//
//   guard ids → read signals → read library → curate → verify → merge → publish
//
// Flags:
//   --dry-run              do everything, write nothing
//   --no-curate            skip curation; rebuild the published files from the
//                          archive and current signals. Use this after editing
//                          signals or to re-publish without curating.
//   --from-candidates=F    read candidates from a JSON file instead of calling
//                          the API. This is how the scheduled cloud routine
//                          works: a Claude Code session does the searching under
//                          the subscription and writes the file; everything
//                          downstream — verification, ids, dedupe, archive,
//                          publish — is identical either way. The guards do not
//                          care who did the curating.
//   --want=N               target item count for this run (default 8)

import fs from "node:fs";
import { FEED, PATHS, ORIGIN, TOPICS, KINDS } from "./lib/config.mjs";
import { assertIdsStable, idFor, normaliseUrl } from "./lib/url.mjs";
import { readSignals, summarise } from "./lib/signals.mjs";
import { loadLibrary, digest } from "./lib/library.mjs";
import { verifyAll } from "./lib/verify.mjs";
import {
  loadArchive,
  loadIndex,
  mergeIntoArchive,
  perDay,
  publishedIds,
  saveArchive,
  saveDay,
  saveIndex,
} from "./lib/archive.mjs";
import {
  poolHealth,
  selectLive,
  writeFeed,
  writeSite,
  writeStatus,
} from "./lib/publish.mjs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const DRY = has("--dry-run");
const NO_CURATE = has("--no-curate");
const FROM_FILE = valueOf("from-candidates", null);
const WANT = Number(valueOf("want", "8"));

const log = (...parts) => console.log(...parts);
const started = new Date();
const ranAt = started.toISOString();
const today = ranAt.slice(0, 10);

/**
 * Read and validate a candidates file written by the scheduled cloud routine.
 *
 * Validated hard, and with actionable messages: the writer is an agent session
 * that can read the error and fix its own file. Anything malformed is rejected
 * here rather than being carried into the archive, where a bad topic or a missing
 * id would be permanent.
 */
function readCandidateFile(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`could not read ${file}: ${err.message}`);
  }

  const list = Array.isArray(raw) ? raw : raw.items;
  if (!Array.isArray(list)) {
    throw new Error(
      `${file} must be a JSON array of candidates, or an object with an "items" array`,
    );
  }

  const problems = [];
  const ok = [];

  list.forEach((c, i) => {
    const at = `candidate ${i + 1}${c && c.url ? ` (${c.url})` : ""}`;
    const missing = ["url", "title", "source", "topic", "kind", "summary", "note"].filter(
      (f) => !c || typeof c[f] !== "string" || !c[f].trim(),
    );
    if (missing.length) {
      problems.push(`${at}: missing or empty ${missing.join(", ")}`);
      return;
    }
    if (!TOPICS.includes(c.topic)) {
      problems.push(`${at}: topic "${c.topic}" is not one of ${TOPICS.join(", ")}`);
      return;
    }
    if (!KINDS.includes(c.kind)) {
      problems.push(`${at}: kind "${c.kind}" must be timely or evergreen`);
      return;
    }
    if (!/^https?:\/\//i.test(c.url)) {
      problems.push(`${at}: url must be an absolute http(s) URL`);
      return;
    }
    const date = c.date_published || `${today}T00:00:00Z`;
    if (!Number.isFinite(Date.parse(date))) {
      problems.push(`${at}: date_published "${c.date_published}" is not ISO 8601`);
      return;
    }
    ok.push({ ...c, date_published: new Date(date).toISOString() });
  });

  if (problems.length) {
    throw new Error(
      `${problems.length} invalid candidate(s) in ${file}:\n  ` +
        problems.join("\n  "),
    );
  }
  if (!ok.length) throw new Error(`${file} contained no candidates`);

  return ok;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  log(`\n  Life of K² — run ${ranAt}`);
  log(`  origin ${ORIGIN}${DRY ? "   [DRY RUN — nothing will be written]" : ""}\n`);

  // ---------------------------------------------------------------- 1. archive
  let archive = loadArchive();
  const index = loadIndex();

  // The guard. If normalisation has drifted, every dismissal for the affected
  // items would silently come undone tonight. Fail here instead.
  assertIdsStable(archive);
  log(`  ids        ${archive.length} archived, all stable`);

  // ---------------------------------------------------------------- 2. signals
  const signals = await readSignals();
  log(
    signals.available
      ? `  signals    ${signals.read.size} read · ${signals.irrelevant.size} not relevant`
      : `  signals    unavailable (${signals.error}) — publishing without read-state`,
  );

  // ---------------------------------------------------------------- 3. curate
  const dropped = [];
  let fresh = [];
  let searches = 0;

  if (NO_CURATE) {
    log("  curation   skipped (--no-curate)");
  } else {
    let candidates = [];

    if (FROM_FILE) {
      candidates = readCandidateFile(FROM_FILE);
      log(`  curation   ${candidates.length} candidates from ${FROM_FILE}`);
    } else {
      const library = await loadLibrary();
      log(
        library.error
          ? `  library    ${library.records.length} records ${
              library.stale ? "(STALE cache)" : ""
            } — ${library.error}`
          : `  library    ${library.records.length} records, live from Notion`,
      );

      // Imported here rather than at the top so a rebuild or a --from-candidates
      // run needs neither the Anthropic SDK nor an API key.
      const { curate } = await import("./lib/curate.mjs");

      const liveNow = selectLive(archive, signals, started);
      const health = poolHealth(liveNow);

      log(`  pool       ${health.total} live · ${health.timely} timely`);
      log("  curating   searching…");

      const result = await curate({
        today,
        interests: readText(PATHS.interests),
        sources: readText(PATHS.sources),
        libraryDigest: digest(library),
        publishedUrls: archive.slice(-300).map((i) => i.url),
        want: WANT,
        poolState: { total: health.total, timely: health.timely },
      });
      candidates = result.candidates;
      searches = result.searches;
      log(`  curating   ${candidates.length} candidates from ${searches} searches`);
    }

    // ------------------------------------------------------------- 4. verify
    const seen = publishedIds(archive);
    const unseen = [];
    for (const candidate of candidates) {
      let id;
      try {
        id = idFor(candidate.url);
      } catch {
        dropped.push({ code: "malformed", url: candidate.url, when: "this run" });
        continue;
      }
      if (seen.has(id)) continue; // rule 3: published once, never again
      if (unseen.some((c) => c.id === id)) continue; // same article, two sources
      unseen.push({ ...candidate, id });
    }

    log(`  verifying  ${unseen.length} new URLs…`);
    const checked = await verifyAll(unseen, { concurrency: 5 });

    let inconclusive = 0;
    for (const { candidate, check, image } of checked) {
      if (check.status === "dead") {
        dropped.push({ code: check.code, url: candidate.url, when: "this run" });
        continue;
      }
      if (check.status === "inconclusive") inconclusive += 1;

      // The final URL after redirects is the canonical one, so the id is derived
      // from that — not from whatever the search result happened to say.
      const url = normaliseUrl(check.finalUrl);
      fresh.push({
        id: idFor(url),
        url,
        title: candidate.title,
        summary: candidate.summary,
        date_published: candidate.date_published,
        _homepage: {
          kind: candidate.kind,
          topic: candidate.topic,
          source: candidate.source,
          note: candidate.note,
          published_at: ranAt,
          image: image || null,
          ...(check.status === "inconclusive" ? { verified: "bot-walled" } : {}),
        },
      });
    }

    // Redirects can collapse two candidates onto one canonical URL.
    const byId = new Map(fresh.map((i) => [i.id, i]));
    fresh = [...byId.values()].filter((i) => !seen.has(i.id));

    log(
      `  verified   ${fresh.length} publishable · ${dropped.length} dropped · ${inconclusive} bot-walled (kept)`,
    );
    log(`  images     ${fresh.filter((i) => i._homepage.image).length} of ${fresh.length}`);
  }

  // ---------------------------------------------------------------- 5. merge
  const merged = mergeIntoArchive(archive, fresh);
  archive = merged.archive;
  assertIdsStable(archive); // belt and braces: never write a drifted archive

  // ---------------------------------------------------------------- 6. publish
  const live = selectLive(archive, signals, started);
  const health = poolHealth(live);

  const runRecord = {
    day: today,
    ran_at: ranAt,
    published: merged.added.length,
    dropped: dropped.length,
    searches,
    ok: true,
  };
  const nextIndex = { runs: [...index.runs.filter((r) => r.day !== today), runRecord] };

  const status = {
    last_run_ok: true,
    ran_at: ranAt,
    per_day: perDay(nextIndex, 30),
    dropped,
    signals: summarise(signals),
    pool: health,
    library_stale: NO_CURATE ? null : undefined,
    verification: {
      checked: fresh.length + dropped.length,
      published: fresh.length,
      dropped: dropped.length,
    },
  };

  if (DRY) {
    log("\n  DRY RUN — would have written:");
    log(`    feed.json    ${live.length} items`);
    log(`    site.json    ${archive.length} items`);
    log(`    archive      +${merged.added.length}`);
    summary(health, live, archive);
    return;
  }

  saveArchive(archive);
  if (merged.added.length) saveDay(today, merged.added, { ranAt, dropped });
  saveIndex(index, runRecord);

  const feed = writeFeed(live, ranAt);
  const site = writeSite(archive, signals, ranAt);
  writeStatus(status);

  const feedBytes = fs.statSync(PATHS.feed).size;
  const siteBytes = fs.statSync(PATHS.site).size;

  log(`\n  wrote      feed.json  ${feed.items.length} items, ${(feedBytes / 1024).toFixed(1)}KB`);
  log(`             site.json  ${site.items.length} items, ${(siteBytes / 1024).toFixed(1)}KB`);
  log(`             status.json`);
  summary(health, live, archive);
}

function summary(health, live, archive) {
  const floorLine = (label, have, floor) =>
    `    ${label.padEnd(18)} ${String(have).padStart(3)} / ${floor}  ${
      have >= floor ? "ok" : "SHORT"
    }`;
  log("\n  pool health");
  log(floorLine("undismissed", health.total, FEED.floorItems));
  log(floorLine("timely", health.timely, FEED.floorTimely));
  log(`    ${"feed cap".padEnd(18)} ${String(live.length).padStart(3)} / ${FEED.cap}`);
  log(`    ${"archive".padEnd(18)} ${String(archive.length).padStart(3)} total`);
  log(
    "\n  topics     " +
      Object.entries(health.topics)
        .map(([t, n]) => `${t} ${n}`)
        .join(" · "),
  );
  if (!health.meetsTimelyFloor) {
    log("\n  ! timely floor not met — next run will widen the search automatically.");
  }
  log("");
}

main().catch((err) => {
  console.error(`\n  RUN FAILED: ${err.message}\n`);
  if (!DRY) {
    try {
      const existing = JSON.parse(fs.readFileSync(PATHS.status, "utf8"));
      writeStatus({
        ...existing,
        last_run_ok: false,
        ran_at: ranAt,
        error: String(err.message || err).slice(0, 500),
      });
    } catch {
      /* no prior status to annotate */
    }
  }
  process.exitCode = 1;
});
