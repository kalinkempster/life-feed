# site/ — what Vercel deploys

Static, plus one function. No framework, no build step at deploy time — the
generator produces the JSON ahead of the push, and Vercel serves the folder.

    site/
      index.html    the reading room — renders site.json
      status.html   generator diagnostics — renders status.json
      feed.json     the dashboard's feed. Contract v1, capped at 200, lean.
      site.json     the reading room's feed. Everything ever published, with
                    notes, images and read-state. No cap.
      status.json   last run, per-day history, drops, signal counters
      favicon.svg
      api/signal.js POST endpoint for dismissal signals → Upstash Redis
      vercel.json   content-type, cache and CORS headers; noindex everything

## Two feeds, on purpose

`feed.json` carries only the fields contract v1 defines. `_homepage.note` is a
site-only field and shipping it to the dashboard was roughly 40% of the payload
for a field the dashboard explicitly ignores — 200 items came to 122KB against a
contract that targets ~50KB. Split and minified, a full 200-item `feed.json` is
about 85KB raw and **35KB over the wire** once Vercel gzips it.

The site reads `site.json` and falls back to `feed.json`, so the page still
renders if a run writes one but not the other.

## Deploying

Import the repo in Vercel and set **Root Directory = `site`**. Framework preset:
Other. No build command, no output directory.

> The repo currently has these files at its **root** rather than under `site/`,
> which means Vercel's Root Directory is `.`. Moving them into `site/` — so the
> generator, the curation brief and the handoff live in the repo without being
> served — requires flipping that one setting at the same time.

## Updating the feed

The generator overwrites `feed.json`, `site.json` and `status.json` and commits.
Vercel redeploys on push. Nothing else in this folder changes day to day.

## /api/signal

`POST` one JSON object per dismissal:

    { "id": "<64 hex>", "reason": "read" | "irrelevant",
      "topic": "medicine", "source": "EMCrit", "at": "..." }

Always answers **202 with no body**, whatever happens downstream — a dismissal
must never be blocked or surfaced as an error. Writes to Upstash Redis when it is
configured and silently discards when it is not. `id` and `reason` are validated
before anything is written; the endpoint is public and unauthenticated, so it must
not become a way to write arbitrary keys.

**`_homepage.signals_url` is only published in `feed.json` when `SIGNALS_ENABLED=1`.**
Until then it is absent, which is the contract's own default: the dashboard keeps
dismissals local. Publishing the URL while the route 404s means every dismissal is
fired into a wall and the failure is swallowed by design.

## What is NOT here

Everything at the repo root: the curation brief, the handoff, the generator, the
archive, the design files. The generator reads those; Vercel does not need them.
