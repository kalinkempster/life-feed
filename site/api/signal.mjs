// POST /api/signal — one object per dismissal from the dashboard.
//
// This file is .mjs deliberately. Vercel's Root Directory is `site/`, which has no
// package.json, so a `.js` function is loaded as CommonJS and `export default` is a
// syntax error at module load — the route deploys and then 500s on every request.
//
// The contract's promise to the caller is absolute: fire-and-forget. Always 202,
// never a body to parse, never an error that could surface to the user or block a
// dismissal. If Redis is down, the signal is lost and that is the correct
// tradeoff — this is the least important thing on the page and must never shout.
//
// It records only what Kal deliberately said, in two words, about an item he chose
// to act on. Not click tracking, not dwell time, not a behavioural profile.

const KEYS = {
  read: "signals:read",
  irrelevant: "signals:irrelevant",
  interested: "signals:interested",
  meta: "signals:meta",
};

// Two independent axes, not one list of states.
//
//   status  unread ↔ read          "have I consumed this"
//   rating  none ↔ up ↔ down       "what did I think of it"
//
// Something can be read AND liked — that is the normal case for a good article,
// and collapsing both into one slot meant marking it read silently wiped the
// rating. Each reason moves exactly one axis and leaves the other alone.
const STATUS = { read: true, unread: false };
const RATING = { interested: "interested", irrelevant: "irrelevant", unrated: null };
// `clear` resets both, which is what it has always meant.
const REASONS = new Set([...Object.keys(STATUS), ...Object.keys(RATING), "clear"]);
const TOPICS = new Set([
  "medicine",
  "news",
  "records",
  "photography",
  "fashion",
  "gaming",
  "melbourne",
  "other",
]);

function accepted(res) {
  // 202 with no body, every single time.
  res.statusCode = 202;
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

async function persist(signal) {
  const url = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) return;

  const commands = [];
  const { reason, id } = signal;

  if (reason === "clear") {
    commands.push(["SREM", KEYS.read, id]);
    commands.push(["SREM", KEYS.interested, id]);
    commands.push(["SREM", KEYS.irrelevant, id]);
    commands.push(["HDEL", KEYS.meta, id]);
  } else if (reason in STATUS) {
    // Status axis only. The rating sets are not touched.
    commands.push([STATUS[reason] ? "SADD" : "SREM", KEYS.read, id]);
  } else {
    // Rating axis only. `read` is not touched.
    const target = RATING[reason];
    for (const key of [KEYS.interested, KEYS.irrelevant]) {
      if (key !== KEYS[target]) commands.push(["SREM", key, id]);
    }
    if (target) commands.push(["SADD", KEYS[target], id]);
  }

  // Keep a metadata row for anything still asserted, so curation can see the
  // topic and source behind a rating; drop it only when nothing is left to say.
  if (reason !== "clear") {
    commands.push(["HSET", KEYS.meta, id, JSON.stringify(signal)]);
  }

  await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }

  // Everything past this point is best-effort. The caller gets its 202 regardless.
  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const id = String(body.id || "");
    const reason = String(body.reason || "");

    // Validate rather than trust: this endpoint is public and unauthenticated, so
    // it must not become a way to write arbitrary keys or unbounded values.
    if (/^[0-9a-f]{64}$/.test(id) && REASONS.has(reason)) {
      await persist({
        id,
        reason,
        topic: TOPICS.has(String(body.topic)) ? String(body.topic) : null,
        source: String(body.source || "").slice(0, 40) || null,
        at: new Date().toISOString(),
      });
    }
  } catch {
    /* swallowed on purpose — see the note at the top */
  }

  return accepted(res);
}
