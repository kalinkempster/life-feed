#!/usr/bin/env node
// Send the morning notification.
//
//   node generator/send-push.mjs            send if it is 07:00 in Melbourne
//   node generator/send-push.mjs --force    send regardless of the clock
//   node generator/send-push.mjs --dry-run  say what it would do, send nothing
//
// The push carries NO payload. The service worker fetches notify.json when the
// phone wakes, so the notification describes the edition as it stands at that
// moment rather than as it stood when this ran — and there is no per-subscription
// encryption to get wrong.

import webpush from "web-push";
import fs from "node:fs";
import { ORIGIN, PATHS, SITE } from "./lib/config.mjs";
import { melbourneHour, editionDay } from "./lib/day.mjs";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY = args.includes("--dry-run");
const KEY = "push:subs";

const redis = {
  url: (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, ""),
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
};

async function pipeline(commands) {
  const res = await fetch(`${redis.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${redis.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  return rows.map((r) => {
    if (r && r.error) throw new Error(`upstash: ${r.error}`);
    return r ? r.result : null;
  });
}

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

// ------------------------------------------------------------------ the clock
// Cron is UTC-only and Melbourne moves twice a year, so the schedule fires either
// side of the change and this decides which firing is the real one. Checking the
// actual local hour means the notification lands at 07:00 in both halves of the
// year without two schedules that have to be remembered and edited.
const hour = melbourneHour();
if (!FORCE && hour !== 7) {
  console.log(`\n  It is ${String(hour).padStart(2, "0")}:00 in Melbourne, not 07:00. Nothing to do.\n`);
  process.exit(0);
}

// ------------------------------------------------------------- is there news?
let notify;
try {
  notify = JSON.parse(fs.readFileSync(PATHS.notify, "utf8"));
} catch {
  console.log("\n  No notify.json — no edition has been published yet. Nothing to send.\n");
  process.exit(0);
}

const today = editionDay(new Date());
if (!FORCE && notify.day !== today) {
  // Overnight run failed, or nothing was published. Better to send nothing than to
  // announce yesterday's edition as though it were this morning's.
  console.log(
    `\n  notify.json is for ${notify.day}, today is ${today} — no edition landed overnight. Sending nothing.\n`,
  );
  process.exit(0);
}

console.log(`\n  Edition ${notify.day}: ${notify.count} new, ${notify.timely} timely`);
console.log(`  Topics: ${notify.topics.join(", ")}`);
for (const h of notify.headlines.slice(0, 3)) console.log(`   · ${h.source} — ${h.title}`);

// ------------------------------------------------------------------ the keys
if (!redis.url || !redis.token) die("UPSTASH_REDIS_REST_URL/TOKEN are not set");

const privateKey = process.env.VAPID_PRIVATE_KEY || "";
if (!privateKey) {
  die(
    "VAPID_PRIVATE_KEY is not set. Run `npm run vapid` locally and add the printed " +
      "key as an Actions secret.",
  );
}

let publicKey, subject;
try {
  ({ publicKey, subject } = JSON.parse(fs.readFileSync(`${SITE}/push-key.json`, "utf8")));
} catch {
  die("site/push-key.json is missing — run `npm run vapid`");
}

webpush.setVapidDetails(subject || `mailto:noreply@example.com`, publicKey, privateKey);

// ------------------------------------------------------------ the subscribers
const [raw] = await pipeline([["HGETALL", KEY]]);
const flat = Array.isArray(raw) ? raw : [];
const subs = [];
for (let i = 0; i < flat.length; i += 2) {
  try {
    subs.push({ id: flat[i], ...JSON.parse(flat[i + 1]) });
  } catch {
    /* a malformed row is not worth failing the morning over */
  }
}

if (!subs.length) {
  console.log(`\n  No devices subscribed. Turn on "Daily digest" in the site footer.\n`);
  process.exit(0);
}

console.log(`\n  ${subs.length} subscribed device(s)`);

if (DRY) {
  console.log(`\n  DRY RUN — nothing sent.\n`);
  process.exit(0);
}

// ----------------------------------------------------------------- send them
let sent = 0;
const expired = [];

for (const sub of subs) {
  try {
    // No payload: the worker fetches notify.json itself. TTL of four hours, so a
    // phone that is off all morning does not get yesterday's news at lunchtime.
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      null,
      { TTL: 4 * 3600, urgency: "normal" },
    );
    sent += 1;
  } catch (err) {
    const status = err.statusCode;
    // 404/410 mean the browser threw the subscription away — the device was reset,
    // the app removed, permission revoked. Prune it rather than failing here every
    // morning forever.
    if (status === 404 || status === 410) {
      expired.push(sub.id);
      console.log(`   pruning expired subscription ${sub.id.slice(0, 8)}… (${status})`);
    } else {
      console.error(`   send failed for ${sub.id.slice(0, 8)}…: ${status || err.message}`);
    }
  }
}

if (expired.length) {
  await pipeline([["HDEL", KEY, ...expired]]);
}

console.log(`\n  ✓ sent ${sent} of ${subs.length}${expired.length ? `, pruned ${expired.length}` : ""}\n`);

// A morning where every device failed is worth a red run; some failing is not.
if (sent === 0 && subs.length > expired.length) {
  die("no notification reached any device");
}
