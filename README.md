# site/ — what Vercel deploys

Static. No framework, no build step, no dependencies. Vercel serves this folder as-is.

    site/
      index.html    the feed — fetches /feed.json and renders it
      status.html   generator diagnostics — reads /status.json if the generator wrote one
      feed.json     the file the dashboard fetches
      vercel.json   content-type, cache and CORS headers for feed.json; noindex everything

## Deploying

Import the repo in Vercel and set **Root Directory = `site`**. Framework preset: Other.
No build command, no output directory. Done.

## Updating the feed

The generator's only job on this side is to overwrite `site/feed.json` and commit.
Vercel redeploys on push. Nothing else in this folder changes day to day.

Optionally it can also write `site/status.json`:

    {
      "last_run_ok": true,
      "per_day": [8, 6, 9, ...],
      "dropped": [{ "code": "404", "url": "https://…", "when": "Today 19:00" }],
      "signals": { "read": 128, "irrelevant": 36, "week": 4, "top_topic": "medicine" }
    }

Absent, /status.html still works — it derives pool health from the feed and shows the
rest as placeholders.

## What is NOT here

Everything at the repo root: the curation brief, the handoff, the design files. The
generator reads those; Vercel does not need them.
