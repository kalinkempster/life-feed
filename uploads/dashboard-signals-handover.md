# Handover — three-way feedback, dashboard side

**For the Home Page dashboard repo.** Written by the feed project, 2026-09-05.
Companion to `feed-contract.md`; that document still governs everything else.

The feed site now has a three-way feedback control on every item. This is what the
dashboard needs to do to share the same state, and the exact shapes to build to.
The feed side is already deployed and answering — nothing here is waiting on me.

---

## What changed on the feed side

Contract v1 defined two dismissal reasons, `read` and `irrelevant`. There is now a
third, `interested` — a thumbs-up meaning *more like this* — plus `clear` to retract
a previous statement.

**This is additive, not breaking.** `_homepage.contract` stays absent (v1). A
dashboard that ignores all of this keeps working exactly as before.

Two concrete changes you can see:

1. `POST /api/signal` accepts four reasons instead of two.
2. `feed.json` items may now carry `_homepage.rated: "interested"`.

---

## 1. The endpoint

    POST https://life-of-kk.vercel.app/api/signal
    Content-Type: application/json

```json
{ "id": "a3f1c9e07b42…", "reason": "read" | "irrelevant" | "interested" | "clear",
  "topic": "medicine", "source": "EMCrit", "at": "2026-09-05T02:10:00Z" }
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | exactly the item's `id` from `feed.json`. 64 lowercase hex. Anything else is silently ignored. |
| `reason` | yes | one of the four above |
| `topic` | no | the item's canonical topic; used to build the curator's ratings brief |
| `source` | no | the item's source label; same purpose |
| `at` | no | ISO 8601. The server stamps its own if absent. |

**It always answers `202` with an empty body.** Not 200, not a JSON result — there
is nothing to parse and nothing to await. It answers 202 even for malformed input,
even when the store behind it is down. That is deliberate: a dismissal must never
be blocked, retried, or surfaced to the user as an error.

So: fire-and-forget. `keepalive: true` is worth setting so a signal sent as the
popup closes still goes out.

```js
fetch(signalsUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id, reason, topic, source, at: new Date().toISOString() }),
  keepalive: true,
}).catch(() => {});   // swallow — never surface, never block the UI
```

### Semantics

- **One state per item at a time.** A later statement *replaces* an earlier one; it
  does not accumulate beside it. Sending `interested` for an item previously marked
  `read` leaves it interested only.
- **`clear` retracts.** Send it when the user un-toggles a control.
- **Idempotent.** Re-sending the same reason is harmless.

---

## 2. Reading state back

The feed reflects signals at build time, once daily. Do not expect a POST to change
`feed.json` immediately — it will not, and that is fine.

**Read and dismissed items disappear from `feed.json` on the next build.** They are
filtered out server-side. You do not need to do anything to hide them; the pool
itself is the answer. This is the main sync mechanism and it needs no new code.

**Rated-up items stay in the pool and gain a marker:**

```json
{
  "id": "…", "url": "…", "title": "…", "summary": "…", "date_published": "…",
  "_homepage": {
    "kind": "timely", "topic": "medicine", "source": "EMCrit",
    "rated": "interested"
  }
}
```

`_homepage.rated` is **optional and only ever present on items the user rated up**.
It exists so the dashboard can render the thumbs-up as already-pressed rather than
disagreeing with the site. Treat a missing key as "no rating". Do not assume it will
ever hold `"read"` or `"irrelevant"` — those items are not in the feed at all.

---

### Reading live state, not just build-time state

`GET https://life-of-kk.vercel.app/api/signals` returns the current sets, ids only:

```json
{ "read": ["…"], "irrelevant": ["…"], "interested": ["…"], "available": true }
```

Uncached, CORS-open, and it degrades to empty arrays with `available: false`
rather than erroring when the store is unreachable — so it is always safe to call
and never worth blocking on.

Use it if you want the dashboard to reflect a rating made on the site without
waiting for the next build. `_homepage.rated` in `feed.json` gives you the same
information a day late; this gives it immediately. Treat `available: false` as
"no information", not as "no signals" — falling back to the feed's own state.

The precedence the site uses, and the one worth matching: **local intent wins**,
then live server state, then whatever the last build baked in.

## 3. `signals_url` — read this before wiring anything

Contract v1 says: send signals only if `_homepage.signals_url` is present; absent
means keep them local.

**It is now present**, as of 2026-09-05: the store is configured and the whole loop
is verified on every build. You can send immediately.

Build the outbox below anyway. The feed withholds `signals_url` whenever a build
cannot prove the round trip works, so it can go absent again — a rotated token, a
Vercel redeploy that drops an environment variable. When it does, the correct
behaviour is to queue rather than to fire into a wall:

1. On each fetch, read `feed._homepage.signals_url`.
2. Record every dismissal or rating locally, always — that is your source of truth
   for what to hide, exactly as today.
3. Also append it to a small **outbox** in `chrome.storage.local`.
4. If `signals_url` is present, flush the outbox to it, dropping entries on success.
   If absent, leave the outbox alone and try again next fetch.

That way nothing is lost during the gap, and the day the key appears the backlog
goes out on the next refresh with no code change and no migration.

Do **not** hardcode the origin as a workaround for the missing key. The key's
absence is the feed telling you not to send yet; hardcoding past it means silently
throwing away every signal until the store exists.

Cap the outbox (a few hundred entries) so it cannot grow without bound, same
reasoning as the existing 500-id dismissal cap.

---

## 4. Local state stays authoritative for display

Do not replace the existing local dismissal list with server state. Keep the model
the feed site uses:

- **Local is an optimistic overlay.** It is the more recent statement, it survives
  offline, and it makes the UI instant.
- **Server state is the build-time baseline**, arriving via the pool contents and
  `rated`.
- On conflict, local wins.

Concretely: an item the user dismissed thirty seconds ago must stay hidden even
though it is still in `feed.json` until tomorrow's build.

---

## 5. UI, for consistency with the site

Three controls per item. The site uses a tick, a thumbs-up and a thumbs-down:

| Control | Reason sent | Meaning |
|---|---|---|
| ✓ | `read` | read it — stop showing it |
| thumbs-up | `interested` | more like this; steers future curation |
| thumbs-down | `irrelevant` | not for me — never show again |

Clicking an already-active control sends `clear` and un-toggles it.

Match this mapping even if the visual treatment differs — the dashboard has a
tick-and-cross idiom already and 195px columns, so cramming three icons in may not
fit. **The mapping matters; the iconography does not.** If only two fit, keep
`read` and `irrelevant` and drop the thumbs-up: it is the one signal the site is
better placed to collect anyway.

---

## 6. What not to build

From the contract, still true and worth repeating:

- No click tracking, no dwell time, no hover or impression events. The signal
  records only what Kal deliberately said, in one word, about an item he chose to
  act on. Three words now instead of two; the principle is unchanged.
- Do not send anything on render, scroll or focus. Only on an explicit click.
- Do not batch signals into a behavioural profile or add fields beyond those above.
  Anything extra is ignored by the server and should not be sent.

---

## 7. Checklist

- [ ] Three controls per item, mapped as in §5 (two is acceptable — see the note)
- [ ] Clicking an active control sends `clear`
- [ ] Local dismissal list still authoritative for display; local wins on conflict
- [ ] `_homepage.rated === "interested"` renders the thumbs-up as pressed
- [ ] Outbox in `chrome.storage.local`, capped, flushed only when `signals_url` is present
- [ ] POSTs are fire-and-forget: `.catch(() => {})`, `keepalive: true`, never awaited
- [ ] Nothing breaks when `signals_url` is absent, which is the state today
- [ ] Host permission for `life-of-kk.vercel.app` covers the POST as well as the GET

## Verifying without waiting for me

The endpoint is live now. This should print `202` and an empty body:

```bash
curl -i -X POST https://life-of-kk.vercel.app/api/signal \
  -H 'Content-Type: application/json' \
  -d '{"id":"0000000000000000000000000000000000000000000000000000000000000000","reason":"interested","topic":"medicine","source":"EMCrit"}'
```

A `405` means you used GET. A `404` means the origin is wrong. Anything else, tell
the feed side — it should be unreachable.
