# Handoff — Life of K-Squared

The feed site that publishes `feed.json` for the Home Page dashboard, per
`uploads/feed-contract.md` (contract v1). Design is settled; this file is the brief for
Code to build against.

## What exists here

| File | What it is |
|---|---|
| `Life-of-K-Squared.dc.html` | The feed site. Design reference — the real thing is React/Next. |
| `Status.dc.html` | The /status page. |
| `feed-data.js` | Sample pool in the item shape. Replace with the real fetch. |
| `curation/interests.md` | The curation brief. Read every run. |
| `curation/library.md` | How the record library is reached. |
| `curation/sources.md` | Source weighting. |
| `Feed-A-Broadsheet` / `-B-Ledger` / `-C-TwoColumn` | Rejected candidates, kept for reference. |

## Product decisions (settled — do not relitigate)

- **The site is a reading room**, not a shop window. The dashboard shows 5 a day; the
  site is where the rest of the pool lives.
- **Editions are the default view** — one section per publish day, so a thin day looks
  thin. A **River** toggle (top-right of the feed column) drops the date headers.
- **Chips dominate**: 7 topics with counts, timely/evergreen, read. Single-select,
  click again to clear. In a left rail on desktop, a wrapping chip bar on phone.
- **Masthead spans full width above the rail**, centred and unbroken.
- **Edition dropdown** in the rail jumps to a date, listing every edition with its count.
- **Items link straight out** to the source in a new tab. No permalinks, no item pages.
- **`_homepage.note`** is a site-only field, 2–3 sentences, not sent in `summary`.
  The dashboard ignores it.
- **Read state**: items dismissed as *read* render dimmed in place with a tick.
  Items dismissed as *not relevant* do not appear on the site at all — they are a
  count on /status.
- **The site shows everything ever published.** The feed is capped at 200; the site is not.
- **Thumbnails**: OG image per item where one exists, desaturated at rest, full colour
  on hover. Fetched and verified by the generator, never hot-linked unverified.
- **Phone is first-class.** Rail collapses to a chip bar; thumbnails stay.
- **Public but unlisted** — `noindex`, no sitemap, no share buttons.
- **/status is its own page**: last run result, published-per-day for 30 days, links
  dropped for failing verification, topic balance, pool health against the contract
  floors, dismissal signals received.

## Engineering decisions (mine; rationale recorded)

- **Next.js on Vercel, static-exported pages.** `feed.json` is written into `/public`
  at build time so the dashboard's fetch never touches a function or a database — that
  is what keeps the contract's cacheability promise.
- **IDs**: hex SHA-256 of the normalised URL (lowercase host, strip tracking params,
  strip trailing slash, strip fragment). Stable forever; the same article found twice
  produces one item. Never derive from position, timestamp or build number.
- **Link verification** in the generator: HEAD then GET fallback, follow redirects,
  store the final URL, drop anything not 200. Failures are logged to /status, not hidden.
- **Daily cron** (Vercel Cron, 19:00 AEST) runs the generator, commits the new
  `feed.json` and archive entry, triggers a deploy. Git history is the audit trail.
- **Signals**: `POST /api/signal` writes to Upstash Redis (hash `signals:{id}`).
  Read at build time to compute site read-state. Fire-and-forget for the caller —
  always 202, never a body the dashboard has to parse.
- **Record library**: Notion API via `NOTION_TOKEN` + `NOTION_LIBRARY_DB`, read per run,
  cached to `curation/.library-cache.json` as fallback.
- **Headers**: `Cache-Control: public, max-age=900`, `Access-Control-Allow-Origin: *`,
  HTTPS only.

## Deliberately later

- Editing the curation brief through the site (auth + CRUD). Files in Git until then.
- Honouring signals live rather than at build time.
- Any per-item state beyond the two dismissal reasons. No click tracking, no dwell time.

## Env vars

```
NOTION_TOKEN=
NOTION_LIBRARY_DB=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
ANTHROPIC_API_KEY=
```

---

## Built — and where the build corrected this document

The generator, the archive, the signals endpoint and the CI pipeline now exist.
Four decisions above were changed during implementation, each for a reason:

**Vercel Cron → GitHub Actions.** The engineering decision above says a Vercel Cron
runs the generator and "commits the new `feed.json` and archive entry", with "git
history is the audit trail". A Vercel cron fires a serverless function, which cannot
commit to the repository — the two halves of that decision were incompatible.
`.github/workflows/publish.yml` runs the generator, commits, and pushes; the push is
what triggers the Vercel deploy. Same cadence, same deploy, and the audit trail
actually exists. 09:00 UTC is 19:00 AEST (20:00 through AEDT — cron is UTC-only).

**One feed became two.** `_homepage.note` is a site-only field, but it was being
shipped inside the file the dashboard fetches: about 40% of the payload, for a field
the dashboard ignores. At 200 items that was 122KB against a contract targeting
~50KB. Now `feed.json` is contract fields only and `site.json` carries everything
ever published, with notes, images and read-state. 200 items is ~85KB raw, ~35KB
gzipped on the wire.

**`signals_url` is now conditional.** It was published while `/api/signal` 404ed,
so the dashboard would have fired every dismissal into a wall and swallowed the
failure by design. It is emitted only when `SIGNALS_ENABLED=1`. Until then its
absence is the contract's own documented default: the dashboard keeps signals local.

**Link verification has three outcomes, not two.** "Not 200, therefore dead" is
wrong and measurably so — with a default user-agent, LITFL, GamesHub and TheGamer
all refuse, and all three are live in a browser. `dead` (404/410/5xx/DNS) is dropped
and logged; `inconclusive` (403/429 — a bot wall) is kept and flagged. Dropping
those would have binned the highest-weighted medicine source in the brief.

### Still outstanding

- **The pool is 18 items / 5 timely against floors of 40 / 15.** Only real curation
  runs fix this; it needs `ANTHROPIC_API_KEY`.
- **Repo layout.** These files live at the repo root rather than under `site/`, so
  Vercel's Root Directory is `.`. Moving them requires flipping that setting.
- Editing the curation brief through the site (auth + CRUD). Files in Git until then.
- Honouring signals live rather than at build time.

## Rating on the site (extends contract v1)

The site now has its own signal controls, which it did not before: mark read,
thumbs up, thumbs down. Two notes on what this changes.

**`interested` is a third reason, and the contract defines two.** Contract v1 says
the signal records "only what Kal deliberately said, in two words, about an item he
chose to act on". A positive rating is a third word. It is still that same kind of
thing — a deliberate statement about an item, not click tracking, dwell time or a
behavioural profile — so the principle holds, but the extension is deliberate and
belongs in a contract v2 if the dashboard ever wants to send it. The dashboard does
not send it today and does not need to know it exists.

**The feedback loop runs through the repo, not through Redis.** The scheduled
curation routine has no network access to Upstash, so a rating cannot be read live.
The generator reads signals at build time and writes `curation/signals-summary.md`,
committed with the edition; the routine reads it from the brief the next day. That
file is explicitly evidence, not instruction — it never overrides merit, and a weak
item in a liked topic is still a weak item.

A rated-up evergreen item is exempt from the 90-day age-out. You said you wanted it.
