// Link verification and OG image extraction.
//
// Contract rule 2: every URL is verified to resolve before publishing. A curated
// feed that emits a plausible dead link is worse than no feed, and a fabricated
// URL looks exactly like a real one until it is clicked.
//
// But "not 200 therefore dead" is wrong, and measurably so: with a default Node
// user-agent, LITFL, GamesHub and TheGamer all return 403 and one returns a bare
// connection reset. Every one of those articles is live in a browser. A verifier
// that drops them silently bins the highest-weighted medicine source in the brief.
//
// So the outcomes here are three, not two:
//   ok            — reached it, 200. Publish, storing the final URL.
//   dead          — reached it, and it is genuinely gone (404/410/451/5xx) or the
//                   host does not resolve. Drop, and log to /status.
//   inconclusive  — reached the server, and it refused to talk to a robot
//                   (403/429/999). Not evidence of a dead link. Publish, flagged.

import { USER_AGENT } from "./config.mjs";
import { normaliseUrl } from "./url.mjs";

const TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 512 * 1024;

// Status codes that mean "the server is fine, it just will not serve a robot".
const BOT_WALL = new Set([401, 402, 403, 405, 406, 429, 999]);
// Codes that mean the document is genuinely not there.
const GONE = new Set([404, 410, 451]);

const BROWSERISH_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, method, extraHeaders = {}) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: control.signal,
      headers: { ...BROWSERISH_HEADERS, ...extraHeaders },
    });
    return { res, error: null };
  } catch (err) {
    return { res: null, error: err };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify one URL.
 * @returns {Promise<{status:"ok"|"dead"|"inconclusive", code:string, finalUrl:string}>}
 */
export async function verifyLink(rawUrl) {
  let url;
  try {
    url = normaliseUrl(rawUrl);
  } catch {
    return { status: "dead", code: "malformed", finalUrl: rawUrl };
  }

  // HEAD first — cheap, and most hosts answer it honestly.
  let { res, error } = await request(url, "HEAD");

  // A HEAD that 405s, 403s or blows up tells us nothing. Ask properly.
  if (!res || !res.ok) {
    const code = res ? res.status : null;
    if (!res || BOT_WALL.has(code) || code === 501 || code >= 500) {
      ({ res, error } = await request(url, "GET"));
    }
  }

  // Transport failure. Retry once — a reset connection is often a rate limiter
  // and TheGamer's reset resolved to a clean 200 on the retry.
  if (!res) {
    await sleep(1500);
    ({ res, error } = await request(url, "GET"));
  }

  if (!res) {
    const reason = String(error && error.name === "AbortError" ? "timeout" : error?.cause?.code || error?.message || "network");
    // DNS failure is definitive; a timeout or reset is not.
    const definitive = /ENOTFOUND|EAI_AGAIN|ERR_TLS|CERT_/i.test(reason);
    return {
      status: definitive ? "dead" : "inconclusive",
      code: reason.slice(0, 40),
      finalUrl: url,
    };
  }

  const finalUrl = res.url || url;
  const code = String(res.status);
  // We only ever needed the status line; let the socket go.
  try {
    await res.body?.cancel();
  } catch {
    /* HEAD responses have no body to cancel */
  }

  if (res.ok) return { status: "ok", code, finalUrl };
  if (GONE.has(res.status) || res.status >= 500) return { status: "dead", code, finalUrl };
  if (BOT_WALL.has(res.status)) return { status: "inconclusive", code, finalUrl };
  return { status: "dead", code, finalUrl };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function findMeta(html, property) {
  // Attribute order varies, so match the tag then pull content out of it.
  const tagRe = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*>`,
    "i",
  );
  const tag = html.match(tagRe);
  if (!tag) return null;
  const content = tag[0].match(/content\s*=\s*["']([^"']+)["']/i);
  return content ? decodeEntities(content[1]).trim() : null;
}

/**
 * Pull an og:image off a page and confirm the image itself resolves.
 * Returns null rather than an unverified URL — the design calls for thumbnails
 * "fetched and verified by the generator, never hot-linked unverified".
 */
export async function findImage(pageUrl) {
  const { res } = await request(pageUrl, "GET");
  if (!res || !res.ok) return null;
  const html = await readCapped(res);
  if (!html) return null;

  const candidate =
    findMeta(html, "og:image:secure_url") ||
    findMeta(html, "og:image") ||
    findMeta(html, "twitter:image") ||
    findMeta(html, "twitter:image:src");
  if (!candidate) return null;

  let absolute;
  try {
    absolute = new URL(candidate, pageUrl).toString();
  } catch {
    return null;
  }
  if (!/^https:/i.test(absolute)) return null; // the site is HTTPS-only

  const { res: imgRes } = await request(absolute, "GET", { Accept: "image/*,*/*;q=0.8" });
  if (!imgRes || !imgRes.ok) return null;
  const type = imgRes.headers.get("content-type") || "";
  if (!/^image\//i.test(type)) return null;

  // Reject tracking pixels and sprite-sized junk where the host tells us the size.
  const length = Number(imgRes.headers.get("content-length") || 0);
  if (length && length < 3000) return null;

  try {
    await imgRes.body?.cancel();
  } catch {
    /* nothing to clean up */
  }
  return imgRes.url || absolute;
}

async function readCapped(res) {
  const type = res.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(type)) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;

  const chunks = [];
  let total = 0;
  try {
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return Buffer.concat(chunks.map(Buffer.from)).toString("utf8");
}

/**
 * Verify a batch of candidates with bounded concurrency, attaching an image where
 * one can be found and confirmed.
 */
export async function verifyAll(candidates, { concurrency = 5, withImages = true } = {}) {
  const results = [];
  const queue = [...candidates];

  async function worker() {
    while (queue.length) {
      const candidate = queue.shift();
      const check = await verifyLink(candidate.url);
      let image = null;
      if (withImages && check.status !== "dead") {
        try {
          image = await findImage(check.finalUrl);
        } catch {
          image = null;
        }
      }
      results.push({ candidate, check, image });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker),
  );
  return results;
}
