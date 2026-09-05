// Reading dismissal signals from Upstash Redis at build time.
//
// The dashboard fires one POST per dismissal at /api/signal, which writes here.
// This module reads them back so the published files can reflect them:
//   read       — the item renders dimmed in place, with a tick.
//   irrelevant — the item does not appear on the site at all. It becomes a number
//                on /status and nothing more.
//   interested — a positive rating from the site's thumbs-up control. The item
//                stays live and marked; the topics and sources behind it are
//                written to curation/signals-summary.md so the next run's brief
//                reflects what actually landed.
//
// Everything degrades to "no signals" rather than failing the run. A generator
// that refuses to publish because Redis is down is worse than one that publishes
// without read-state for a day.

import { KEYS } from "./config.mjs";

// Read the environment at call time rather than freezing it at import. The store
// is configured by whatever is running the pipeline — Actions secrets in CI, a
// local .env, a mock in the self-test — and a module-load snapshot silently
// ignores anything set afterwards.
const redis = () => ({
  url: (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, ""),
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
});

const configured = () => {
  const { url, token } = redis();
  return Boolean(url && token);
};

async function pipeline(commands) {
  if (!configured()) return null;
  const { url, token } = redis();
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`upstash ${res.status} ${await res.text()}`);
  const payload = await res.json();
  return payload.map((entry) => {
    if (entry && entry.error) throw new Error(`upstash: ${entry.error}`);
    return entry ? entry.result : null;
  });
}

/**
 * @returns {Promise<{available:boolean, read:Set<string>, irrelevant:Set<string>,
 *                    meta:Record<string,object>, error:string|null}>}
 */
export async function readSignals() {
  const empty = {
    available: false,
    read: new Set(),
    irrelevant: new Set(),
    interested: new Set(),
    meta: {},
    error: null,
  };

  if (!configured()) {
    return { ...empty, error: "UPSTASH_REDIS_REST_URL/TOKEN not set" };
  }

  try {
    const [read, irrelevant, interested, meta] = await pipeline([
      ["SMEMBERS", KEYS.read],
      ["SMEMBERS", KEYS.irrelevant],
      ["SMEMBERS", KEYS.interested],
      ["HGETALL", KEYS.meta],
    ]);

    // HGETALL comes back as a flat [field, value, field, value, ...] array.
    const parsed = {};
    const flat = Array.isArray(meta) ? meta : [];
    for (let i = 0; i < flat.length; i += 2) {
      try {
        parsed[flat[i]] = JSON.parse(flat[i + 1]);
      } catch {
        /* a malformed row is not worth failing a run over */
      }
    }

    return {
      available: true,
      read: new Set(read || []),
      irrelevant: new Set(irrelevant || []),
      interested: new Set(interested || []),
      meta: parsed,
      error: null,
    };
  } catch (err) {
    return { ...empty, error: String(err.message || err) };
  }
}

/**
 * Prove the whole signal loop before advertising it.
 *
 * `signals_url` must never be published while the endpoint cannot persist, because
 * the dashboard fires every dismissal at it and swallows the failure by design —
 * the loss is total and completely silent. But "can it persist" is not knowable
 * from the endpoint's own response: it answers 202 to everything, deliberately.
 *
 * It is also not answered by this process being able to reach Redis. The generator
 * reads Redis with Actions secrets; the endpoint writes to it with Vercel
 * environment variables. Those are two different places and either can be missing
 * while the other is fine.
 *
 * So: POST a synthetic signal at the live endpoint, read it back out of Redis, and
 * clean up. Only a full round trip returns true.
 */
const PROBE_ID = "e".repeat(64);

export async function probeSignalLoop(origin) {
  if (!configured()) return { ok: false, reason: "generator cannot reach Redis" };

  try {
    const res = await fetch(`${origin}/api/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: PROBE_ID, reason: "read", topic: "other", source: "probe" }),
    });
    if (res.status !== 202) {
      return { ok: false, reason: `endpoint answered ${res.status}, expected 202` };
    }

    // The handler awaits the write before answering, so this should be immediate.
    // Retry anyway: a Vercel deployment that has only just picked up new
    // environment variables can serve a stale instance for a few seconds, and
    // withholding signals_url for a transient miss costs a whole day of signals.
    let present = 0;
    for (let attempt = 0; attempt < 3 && Number(present) !== 1; attempt += 1) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 750 : 2000));
      [present] = await pipeline([["SISMEMBER", KEYS.read, PROBE_ID]]);
    }

    // Always clean up, whatever the answer, so a probe never shows on /status.
    await pipeline([
      ["SREM", KEYS.read, PROBE_ID],
      ["HDEL", KEYS.meta, PROBE_ID],
    ]);

    return Number(present) === 1
      ? { ok: true, reason: "round trip confirmed" }
      : {
          ok: false,
          reason:
            "endpoint returned 202 but nothing reached Redis after 3 tries — " +
            "the Upstash environment variables are missing or wrong in Vercel, or " +
            "the running deployment predates them (env vars only apply to new deployments)",
        };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

/** Counters for /status. `week` counts signals from the last 7 days. */
export function summarise(signals) {
  if (!signals.available) return null;

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let week = 0;
  const topics = {};

  for (const entry of Object.values(signals.meta)) {
    if (!entry) continue;
    const at = Date.parse(entry.at || "");
    if (Number.isFinite(at) && at >= weekAgo) week += 1;
    if (entry.reason === "read" && entry.topic) {
      topics[entry.topic] = (topics[entry.topic] || 0) + 1;
    }
  }

  const top = Object.entries(topics).sort((a, b) => b[1] - a[1])[0];

  return {
    read: signals.read.size,
    irrelevant: signals.irrelevant.size,
    interested: signals.interested.size,
    week,
    top_topic: top ? top[0] : "—",
  };
}

/**
 * What the ratings actually say, as prose the curator reads next run.
 *
 * This is how a thumbs-up reaches curation. The scheduled routine has no Redis
 * access, so the signal cannot be read live — it is written into the repo here,
 * committed with the edition, and read from the brief tomorrow.
 */
export function ratingsBrief(signals) {
  if (!signals.available) return null;

  const tally = (ids) => {
    const topics = {}, sources = {};
    for (const id of ids) {
      const entry = signals.meta[id];
      if (!entry) continue;
      if (entry.topic) topics[entry.topic] = (topics[entry.topic] || 0) + 1;
      if (entry.source) sources[entry.source] = (sources[entry.source] || 0) + 1;
    }
    const rank = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
    return { topics: rank(topics), sources: rank(sources) };
  };

  const up = tally(signals.interested);
  const down = tally(signals.irrelevant);
  const list = (pairs) =>
    pairs.length ? pairs.map(([k, n]) => `${k} (${n})`).join(" · ") : "nothing yet";

  return [
    "# What the ratings say",
    "",
    "Written by the generator from dismissal and rating signals. Read this alongside",
    "`interests.md`: it is evidence of what actually landed, not a change to the brief.",
    "It never overrides merit — a weak item in a liked topic is still a weak item.",
    "",
    `Rated up: ${signals.interested.size} · dismissed as not relevant: ${signals.irrelevant.size} · read: ${signals.read.size}`,
    "",
    "## More of this",
    "",
    `Topics: ${list(up.topics)}`,
    `Sources: ${list(up.sources)}`,
    "",
    "## Less of this",
    "",
    `Topics: ${list(down.topics)}`,
    `Sources: ${list(down.sources)}`,
    "",
  ].join("\n");
}
