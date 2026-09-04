// URL normalisation and ID derivation.
//
// This is the single most load-bearing file in the project. Dismissals on the
// dashboard are keyed on `id`; if this function's output ever changes for a URL
// that has already been published, every dismissal of that item comes undone and
// the item resurfaces forever. The failure is invisible from here.
//
// Rule: you may add to TRACKING_PARAMS or change normalisation ONLY if
// `assertIdsStable()` still passes against the whole archive. run.mjs calls it on
// every run before anything else happens.

import crypto from "node:crypto";

// Query parameters that identify the referrer, not the resource. Stripping them
// means the same article found via a newsletter and via search is one item.
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^igsh$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^source$/i,
  /^s$/i, // twitter's ?s=20
  /^si$/i, // youtube/spotify share id
  /^cmpid$/i,
  /^_ga$/i,
];

const isTracking = (key) => TRACKING_PARAMS.some((re) => re.test(key));

/**
 * Canonical form of a URL. Deterministic, idempotent, and stable forever.
 * Throws on anything that is not a parseable http(s) URL.
 */
export function normaliseUrl(input) {
  const u = new URL(String(input).trim());

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`not an http(s) URL: ${input}`);
  }

  // Everything is served over TLS; treating http and https as one resource stops
  // the same article arriving twice under two schemes.
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.port = ""; // default port only; :443 and :80 are noise
  u.hash = ""; // fragments are positions in a document, not documents
  u.username = "";
  u.password = "";

  for (const key of [...u.searchParams.keys()]) {
    if (isTracking(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort(); // param order is not part of the identity

  let out = u.toString();
  if (!u.search) out = out.replace(/\?$/, "");
  // A trailing slash is a formatting choice, not a different page.
  out = out.replace(/\/+$/, "");
  return out;
}

/** Hex SHA-256 of the normalised URL. This is the item id. */
export function idFor(url) {
  return crypto.createHash("sha256").update(normaliseUrl(url)).digest("hex");
}

/** True when `url` already normalises to the same canonical form as `other`. */
export function sameResource(url, other) {
  try {
    return normaliseUrl(url) === normaliseUrl(other);
  } catch {
    return false;
  }
}

/**
 * Recompute every archived id and throw if any has drifted.
 *
 * This is the guard that makes the "IDs must be stable" rule enforceable rather
 * than merely documented. Any edit to normaliseUrl that would silently reset the
 * dashboard's dismissal history fails the build here instead.
 */
export function assertIdsStable(items) {
  const drifted = [];
  for (const item of items) {
    if (!item || !item.url || !item.id) continue;
    let recomputed;
    try {
      recomputed = idFor(item.url);
    } catch {
      drifted.push({ url: item.url, stored: item.id, now: "<unparseable>" });
      continue;
    }
    if (recomputed !== item.id) {
      drifted.push({ url: item.url, stored: item.id, now: recomputed });
    }
  }

  if (drifted.length) {
    const detail = drifted
      .slice(0, 10)
      .map((d) => `  ${d.url}\n    stored ${d.stored}\n    now    ${d.now}`)
      .join("\n");
    throw new Error(
      `ID DRIFT: ${drifted.length} archived item(s) no longer hash to their stored id.\n` +
        `Publishing this would undo every dashboard dismissal for them.\n` +
        `Revert the change to normaliseUrl(), or migrate the archive deliberately.\n${detail}`,
    );
  }

  return items.length;
}
