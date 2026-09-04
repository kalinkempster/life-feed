// POST /api/signal — one object per dismissal from the dashboard.
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
  meta: "signals:meta",
};

const REASONS = new Set(["read", "irrelevant"]);
const TOPICS = new Set([
  "medicine",
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

  const set = signal.reason === "read" ? KEYS.read : KEYS.irrelevant;
  const other = signal.reason === "read" ? KEYS.irrelevant : KEYS.read;

  await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["SADD", set, signal.id],
      // A mind changed later wins; an item cannot be both read and irrelevant.
      ["SREM", other, signal.id],
      ["HSET", KEYS.meta, signal.id, JSON.stringify(signal)],
    ]),
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
