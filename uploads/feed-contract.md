# Feed contract — v1

The interface between **Kal's curated feed project** (separate repo, separately hosted)
and the **Home Page dashboard** (this repo).

Agreed 2026-09-04 via `/grill-me`. The dashboard side is **not built yet** — this
document is the target the feed project builds against, and the spec the dashboard will
be built to when the feed is serving.

---

## The shape of the thing

The feed project curates and publishes. The dashboard consumes and displays. Neither
knows anything else about the other.

```
   feed project                         dashboard
   ─────────────                        ──────────
   curates (Claude + research)          GET feed.json      every 60 min, in the worker
   verifies every link resolves    →    caches it          chrome.storage, like any source
   publishes a static JSON file         filters dismissed  locally, never sent unless asked
   daily                                shows 5            3 timely + 2 evergreen
                                   ←    POST a signal      only if signals_url is published
```

**The feed is a static file.** No per-user state, no auth, no personalisation server-side.
That is what keeps it cacheable, cheap and unable to break the dashboard.

---

## Format: JSON Feed 1.1, not RSS

Serve `application/json` conforming to [JSON Feed 1.1](https://jsonfeed.org/version/1.1).

**Not RSS, and this is not a preference.** All fetching in the dashboard happens inside
a Manifest V3 service worker, and `DOMParser` does not exist there. Parsing XML would
mean hand-rolling a parser or moving the fetch back onto the page — which is the
architecture the dashboard deliberately moved away from. JSON is one `.json()` call.

### Top level

```json
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "Kal's feed",
  "home_page_url": "https://feed.example.com",
  "feed_url": "https://feed.example.com/feed.json",
  "_homepage": {
    "generated": "2026-09-04T19:00:00Z",
    "signals_url": "https://feed.example.com/api/signal"
  },
  "items": [ ... ]
}
```

| Field | Required | Notes |
|---|---|---|
| `version` | yes | exactly the 1.1 string |
| `feed_url` | yes | canonical self-reference |
| `_homepage.generated` | yes | ISO 8601 UTC of the publish run. The dashboard shows feed age from this, so a stalled generator is visible rather than silent. |
| `_homepage.signals_url` | no | absent = dashboard keeps dismissal signals local only |
| `items` | yes | the live pool — see cap below |

`_`-prefixed keys are JSON Feed's sanctioned extension mechanism, so this stays a valid
feed for any other reader.

### Items

```json
{
  "id": "a3f1c9e07b42…",
  "url": "https://emcrit.org/…",
  "title": "RV failure in the crashing patient",
  "summary": "Ties directly to the CCPU module you're partway through.",
  "date_published": "2026-09-03T22:00:00Z",
  "_homepage": {
    "kind": "timely",
    "topic": "medicine",
    "source": "EMCrit"
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | **stable across publishes** — see below. This is the load-bearing field. |
| `url` | yes | absolute, verified to resolve — see below |
| `title` | yes | the headline shown. Keep under ~70 chars: it renders in a ~195px column at two lines max. |
| `summary` | no | one sentence, why it's worth *your* time. Not shown on screen — there is no room — it becomes the hover tooltip. Write it for a human, not for SEO. |
| `date_published` | yes | ISO 8601 |
| `_homepage.kind` | yes | `"timely"` or `"evergreen"` |
| `_homepage.topic` | yes | one of the canonical keys below |
| `_homepage.source` | yes | short publisher label, shown as the kicker above the headline. Under ~18 chars. |

### Canonical topic keys

`medicine` · `records` · `photography` · `fashion` · `gaming` · `melbourne` · `other`

Exactly one per item. The dashboard uses it only to enforce variety; the feed does not
need to balance them.

---

## The three rules that will silently break this if ignored

### 1. IDs must be stable across publishes

Dismissals are keyed on `id`. If the generator assigns fresh IDs each build — from
position, timestamp, build number or array index — every dismissal comes undone
overnight and rejected items keep resurfacing. That failure is invisible from the feed
side and infuriating from the dashboard side.

**Derive the ID from the canonical URL.** A hex SHA-256 of the normalised URL (lowercase
host, strip tracking params, strip trailing slash) is ideal: stable forever, collision-free,
and the same article discovered twice from two sources produces one item.

### 2. Every URL must be verified to resolve before publishing

A curated feed that emits a plausible dead link is worse than no feed. One 404 and the
whole thing stops being trusted. The generator must HTTP-check each candidate and drop
anything not returning 200 — following redirects, and storing the final URL.

This matters most precisely because a language model is in the loop: a confidently
fabricated URL looks exactly like a real one until it's clicked.

### 3. Curation is merit-only; the dashboard handles variety

Do not fill topic quotas. Publish the best things found, tagged honestly. The dashboard
refuses to show two items of the same topic in the visible five, which produces the
spread without ever shipping a weak item to satisfy a slot.

Skew the **timely** items toward `medicine` — that is where timeliness has consequences.
Records and photography sit comfortably in evergreen.

---

## Cadence, size, headers

- **Publish daily.** The dashboard refetches every 60 minutes; more often achieves nothing.
- **Cap `items` at 200.** Trim, don't paginate — a hard cap keeps the dashboard dumb and
  the payload around 50KB. The project's own archive can be as large as it likes.
- **Keep at least 40 undismissed items live**, of which at least 15 `timely`. Five slots
  plus enthusiastic dismissing eats a shallow pool fast.
- `Cache-Control: public, max-age=900` is about right.
- CORS headers are optional — the extension's `host_permissions` bypass page CORS — but
  `Access-Control-Allow-Origin: *` costs nothing and makes the feed reusable elsewhere.
- Serve over HTTPS. The dashboard will not fetch plain HTTP.

---

## Dashboard behaviour (for reference — this repo's side)

- **Fetched in the service worker**, cached in `chrome.storage.local`, 60 min TTL. The
  page makes no network call, same as every other source.
- **Displays 5**: 3 `timely`, 2 `evergreen`, no two sharing a `topic`. If a slot cannot
  be filled under those rules, it relaxes the variety rule before it relaxes the mix.
- **Dismissal is permanent**, keyed on `id`, capped at the most recent 500 ids so storage
  cannot grow without limit.
- **Two dismiss reasons**: a tick for *read it*, a cross for *not relevant* — matching the
  existing tick idiom on tasks and inbox rows.
- **Degradation**: a stale feed keeps showing its last good items, labelled by age in the
  header status line, exactly like calendar and weather. A dead feed shows nothing rather
  than an error — this is the least important thing on the page and must never shout.
- **A new host permission** for the feed's origin goes in the manifest.

## Signals (optional, forward-compatible)

If `_homepage.signals_url` is present, the dashboard POSTs one JSON object per dismissal:

```json
{ "id": "a3f1c9e07b42…", "reason": "read" | "irrelevant",
  "topic": "medicine", "source": "EMCrit", "at": "2026-09-04T22:10:00Z" }
```

Fire-and-forget: failures are swallowed and never surface to the user or block the
dismissal. If `signals_url` is absent the dashboard stores signals locally and they can
be exported.

Note what this is and is not. It records only what Kal deliberately said, in two words,
about an item he chose to act on. It is not click tracking, dwell time, or a behavioural
profile — those were considered and rejected (see `council-report-2026-09-04.html`).
Keep it that way.

---

## Amendment, 2026-09-05 — three-way feedback (additive, still v1)

The feed site gained its own feedback control, which the contract did not
anticipate: it assumed the dashboard was the only thing sending signals.

`reason` now describes **two independent axes** rather than one list of states:

- **status** — `read` / `unread`
- **rating** — `interested` (thumbs-up, *more like this*) / `irrelevant` / `unrated`
- `clear` resets both.

Each reason moves exactly one axis. An item can be read *and* rated at the same
time, which is the normal case for a good article; the two must not overwrite one
another. `interested` steers curation rather than dismissing anything.

`feed.json` items may carry an optional `_homepage.rated: "interested"`, present
only on items rated up, so the dashboard can render that state rather than
disagreeing with the site. Read and dismissed items are filtered out of the live
feed server-side and never appear, so no other rating value is possible here.

Both changes are additive: a consumer written to v1 as published ignores the new
reason it never sends and the new key it never reads. `_homepage.contract` stays
absent. The note in "Signals" about what this is and is not still holds — three
deliberate words instead of two, and still not click tracking.

Implementation guidance for the dashboard: `dashboard-signals-handover.md`.

## Amendment, 2026-09-07 — the `news` topic (additive, still v1)

`news` joins the canonical topic keys:

`medicine` · **`news`** · `records` · `photography` · `fashion` · `gaming` ·
`melbourne` · `other`

It covers local news, healthcare news (the system rather than clinical practice,
which stays in `medicine`), global emergency and disaster, and AI. Sport and
celebrity are explicitly excluded. It is capped at roughly two or three items an
edition so it cannot flood the feed.

**`_homepage.contract` deliberately does not move.** Bumping it would make a
dashboard built to v1 ignore the entire feed rather than one unfamiliar key, which
is far worse than the problem it would solve.

**The dashboard must add `news` to its topic list.** It uses `topic` only to
enforce variety, so an unknown key is not catastrophic — but it should be handled
deliberately rather than by accident.

**Recommended, and the durable fix:** treat any unrecognised topic as `other`
rather than dropping the item. Then the next topic added is a feed-side change
only, and this coordination never has to happen again.

## Versioning

Breaking changes to this contract bump `_homepage.contract` (absent = v1). The dashboard
will ignore a feed whose contract version it does not understand rather than render it
wrongly.
