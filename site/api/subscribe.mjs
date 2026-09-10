// POST /api/subscribe — register or drop a push subscription.
//
// A subscription is a URL the push service gave the browser, plus two keys used to
// encrypt payloads. We send no payload, but the keys are stored anyway: dropping
// them would make adding one later a re-subscribe for every device.
//
// Keyed by a hash of the endpoint, so re-enabling on the same device replaces its
// row rather than adding a second one and sending two notifications.

import crypto from "node:crypto";

const KEY = "push:subs";

function redis() {
  return {
    url: (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, ""),
    token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
  };
}

async function pipeline(commands) {
  const { url, token } = redis();
  if (!url || !token) return null;
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  return res.json();
}

const idFor = (endpoint) =>
  crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

/** A subscription we would actually be able to send to. */
function valid(sub) {
  return Boolean(
    sub &&
      typeof sub.endpoint === "string" &&
      /^https:\/\//.test(sub.endpoint) &&
      sub.endpoint.length < 1024 &&
      sub.keys &&
      typeof sub.keys.p256dh === "string" &&
      typeof sub.keys.auth === "string",
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    body = {};
  }

  const sub = body.subscription;
  const unsubscribing = body.action === "unsubscribe";

  if (!valid(sub)) {
    // Unlike /api/signal, this one reports failure: the toggle in the footer needs
    // to know whether it actually worked, because a switch that lies is worse than
    // a switch that refuses.
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: "invalid subscription" }));
  }

  const id = idFor(sub.endpoint);

  try {
    if (unsubscribing) {
      await pipeline([["HDEL", KEY, id]]);
    } else {
      await pipeline([
        [
          "HSET",
          KEY,
          id,
          JSON.stringify({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
            added: new Date().toISOString(),
            agent: String(req.headers?.["user-agent"] || "").slice(0, 120),
          }),
        ],
      ]);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, subscribed: !unsubscribing }));
  } catch (err) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: "store unavailable" }));
  }
}
