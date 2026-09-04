# Life of K²

A Claude-curated feed. The site is the reading room; `feed.json` is the machine
interface consumed by the Home Page dashboard.

    Circulation: one. Standards: unreasonable.

## What's in here

This is now the running project, not just the design package.

| Path | What it is |
|---|---|
| `HANDOFF.md` | Every product decision, the engineering calls, and what's deferred. |
| `uploads/feed-contract.md` | The contract with the dashboard. Contract v1. Authoritative. |
| `generator/` | **The generator.** Runs daily, writes the published files. |
| `archive/` | Every item ever published, plus the per-day audit trail. |
| `site/` | What Vercel deploys. See `site/README.md`. |
| `curation/interests.md` | The brief the generator reads every run. **Edit this to change the feed.** |
| `curation/library.md` | How the record library is reached (Notion). |
| `curation/sources.md` | Source weighting. |
| `Life-of-K-Squared.dc.html` | The original design reference for the feed site. |
| `Status.dc.html` | The original design reference for /status. |
| `Feed-{A,B,C}-*.dc.html` | Earlier candidates, kept for reference. Safe to delete. |

## The shape of the thing

    generator (daily, 09:00 UTC)           site (Vercel)              dashboard
    ────────────────────────────           ─────────────              ─────────
    reads curation/*.md                    renders site.json          GET /feed.json
    reads Notion record library            + /status                  every 60 min
    searches, drafts, tags                 everything ever published  shows 5
    verifies every URL resolves       →    read-state applied         POST /api/signal
    writes feed.json + site.json      →    at build time         ←    on dismissal
    + archive entry, commits, deploys

## Commands

```bash
npm install
npm test              # offline self-test — mocks the API, spends nothing
npm run generate      # a real run (needs ANTHROPIC_API_KEY)
npm run generate:dry  # a real run that writes nothing
npm run rebuild       # rebuild published files from the archive, no Claude call
npm run verify        # contract v1 conformance check
npm run verify:links  # ...and re-check that every URL still resolves
npm run verify:live   # ...against the deployed site
```

## How a run works

1. **Guard the ids.** Every archived id is recomputed from its URL. If normalisation
   has drifted, the run fails here rather than silently undoing every dismissal.
2. **Read signals** from Upstash. `read` dims the item on the site and drops it from
   the live feed; `irrelevant` removes it from both, permanently.
3. **Read the record library** from Notion, falling back to a cached snapshot and
   reporting the staleness on /status.
4. **Curate** — two calls to Claude. A research pass with web search (streamed,
   `pause_turn` resumed explicitly), then a structuring pass that turns the notes
   into schema-validated items. Splitting them means the research call is never
   fighting a JSON schema while it reads.
5. **Verify** every new URL, and fetch an og:image for each.
6. **Merge** into the archive — ids already present are never republished.
7. **Publish** `feed.json`, `site.json`, `status.json`, plus the archive entry.

## The three rules that break this silently

From the contract, repeated because they matter more than anything else here —
and each one now has a test rather than only a paragraph:

1. **IDs must be stable across publishes.** Hex SHA-256 of the normalised URL, never
   position, timestamp or build number. `assertIdsStable()` recomputes the whole
   archive on every run and fails the build on any drift.
2. **Every URL verified before publishing.** With three outcomes, not two: `ok`,
   `dead` (404/410/5xx/DNS — dropped and logged to /status), and `inconclusive`
   (403/429 — a bot wall is *not* evidence of a dead link, so the item is kept and
   flagged). A naive two-outcome verifier drops LITFL, GamesHub and TheGamer, all
   of which are live in a browser.
3. **Curation is merit-only.** Never fill a topic quota. The dashboard handles variety.

## Env

Copy `.env.example`. Only `ANTHROPIC_API_KEY` is needed for a real run; everything
else degrades to a documented fallback rather than failing the run.

    ANTHROPIC_API_KEY=          # curation
    NOTION_TOKEN=               # record library, falls back to cache
    NOTION_LIBRARY_DB=
    UPSTASH_REDIS_REST_URL=     # signals, falls back to no read-state
    UPSTASH_REDIS_REST_TOKEN=
    SITE_ORIGIN=                # defaults to https://life-of-kk.vercel.app
    SIGNALS_ENABLED=            # set to 1 only once /api/signal answers 202
