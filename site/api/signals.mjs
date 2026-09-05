// GET /api/signals — the current signal state, live.
//
// Without this, the two surfaces only agree once a day. The generator reads Redis
// at build time and bakes the result into site.json, so a rating made on the
// dashboard is invisible on the site until the next edition — while a rating made
// on the site appears instantly, because that one writes localStorage. Same
// action, two completely different latencies, which reads as "it didn't work".
//
// So the site asks for the live state on load and layers local intent on top.
// Build-time state stays the fallback for when this is unavailable.
//
// Ids only. No topics, no sources, no timestamps: the page needs to know *which*
// items were acted on, not what was said about them, and this is a public origin.

const KEYS = {
  read: "signals:read",
  irrelevant: "signals:irrelevant",
  interested: "signals:interested",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  // Never cached: the whole point is that it is fresher than the published files.
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }

  const url = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";

  const empty = { read: [], irrelevant: [], interested: [], available: false };

  if (!url || !token) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify(empty));
  }

  try {
    const upstream = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["SMEMBERS", KEYS.read],
        ["SMEMBERS", KEYS.irrelevant],
        ["SMEMBERS", KEYS.interested],
      ]),
    });

    if (!upstream.ok) throw new Error(`upstash ${upstream.status}`);
    const rows = await upstream.json();

    const ids = (row) =>
      Array.isArray(row && row.result)
        ? row.result.filter((id) => /^[0-9a-f]{64}$/.test(id))
        : [];

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({
        read: ids(rows[0]),
        irrelevant: ids(rows[1]),
        interested: ids(rows[2]),
        available: true,
      }),
    );
  } catch {
    // Degrade to "nothing known" rather than erroring: the page falls back to the
    // build-time state, which is stale but correct.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify(empty));
  }
}
