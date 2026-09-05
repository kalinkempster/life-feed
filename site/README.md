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

`POST` one JSON object per dismissal or rating:

    { "id": "<64 hex>", "reason": "read" | "irrelevant" | "interested" | "clear",
      "topic": "medicine", "source": "EMCrit", "at": "..." }

`read` and `irrelevant` are contract v1's two reasons. **`interested` is a
deliberate extension** for the site's thumbs-up control — a positive signal that
steers curation rather than dismissing anything — and `clear` retracts whatever
was said before. The dashboard never sends either; only the site does.

An item holds exactly one state at a time: a later statement replaces an earlier
one rather than accumulating beside it.

Always answers **202 with no body**, whatever happens downstream — a dismissal
must never be blocked or surfaced as an error. Writes to Upstash Redis when it is
configured and silently discards when it is not. `id` and `reason` are validated
before anything is written; the endpoint is public and unauthenticated, so it must
not become a way to write arbitrary keys.

**`_homepage.signals_url` publishes itself, but only once the loop is proven.**
Each run POSTs a synthetic signal at the live endpoint and reads it back out of
Redis; the key is written only on a full round trip. There is no flag to remember.

That check exists because neither half is observable on its own. The endpoint
answers 202 to everything by design, so a missing environment variable and a
successful write look identical from the response. And the generator being able
to reach Redis proves nothing about the endpoint: the generator reads with the
**Actions secrets**, the endpoint writes with the **Vercel environment variables**,
and either can be missing while the other is fine. Publishing the URL while the
write half is broken means every dismissal is fired into a wall and swallowed.

`SIGNALS_ENABLED=0` forces it off regardless, as an escape hatch.

## Rating from the site

Every item carries three controls: mark read, thumbs up, thumbs down.

    read         dims the item in place with a tick, and drops it from the live feed
    interested   marks it, keeps it live, and steers the next run's curation
    irrelevant   collapses the row to an undo strip; gone for good on the next load

State is stored in `localStorage` first, so the controls respond instantly and
survive a reload with no server at all, and POSTed to `/api/signal` so that once
Upstash is configured it reaches the generator. Local state wins over the
build-time baseline — it is the more recent statement.

**Thumbs up only reaches curation once Upstash is configured.** The generator
reads the signals at build time and writes `curation/signals-summary.md`, which
the scheduled routine reads the next day. Without Upstash the buttons still work
in your browser, but nothing influences the feed.

## Phone vs desktop

The two are not the same page and are not meant to be.

- **Filters collapse** behind a `FILTERS` toggle on phones; the active filter is
  named on the collapsed bar so it is never hidden state. Desktop keeps the rail
  open. There is no "everything" chip — a chip toggles off by being tapped again,
  and `Clear filter` appears once anything is on.
- **No thumbnails on phones.** A 76px crop of an article's og:image reads as noise
  at that size. The source's own icon carries the masthead instead, fetched and
  verified by the generator like every other asset — no third-party favicon
  service, which would hand every source's domain to someone else on every load.
- **Kind is a mark, not a word**: an hourglass for timely, a leaf for evergreen.

## What is NOT here

Everything at the repo root: the curation brief, the handoff, the generator, the
archive, the design files. The generator reads those; Vercel does not need them.
