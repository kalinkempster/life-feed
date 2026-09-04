# Record library

**Source of truth: Notion**, read at the start of every run via `NOTION_TOKEN` +
`NOTION_LIBRARY_DB`. Also visible at https://record-library.vercel.app/?view=library
(client-rendered, so not fetchable — do not scrape it).

The generator uses the library to decide what `records` items are worth publishing:
artists owned, labels owned, and adjacent listening. An artist in the library is a
strong signal; a reissue of something not in it is weak.

## The schema, as the generator actually reads it

`NOTION_LIBRARY_DB` is the **Vinyls** database (`f1f3c7aa-…`). 297 records.

| Property | Type | Used as |
|---|---|---|
| `Name` | title | the album title |
| `Artists` | **relation → Artists db** | the artist |
| `Genre` | select | genre |
| `Vibes` | multi_select | vibes |
| `Release Date` | number | year |
| `Play Count` | number | most-played list in the prompt |
| `Status`, `Tracklist`, `Spotify`, `Discogs`, `Cover`, `Last Played`, `Length` | — | not read |

**The artist is a relation, not text.** Reading it naively returns an empty string
for all 297 rows, which would hand the curator a collection with no names in it.
The generator reads the database schema first, queries each related database once,
and maps page ids to titles — one extra request, not one per row.

There is **no label property**, so label-based signals are unavailable. If labels
start mattering, add a `Label` property to Vinyls and the generator will pick it up
automatically — matching is on property-name intent (`/label/i`), not exact strings.

Check what the generator sees at any time:

```bash
npm run library
```

It prints per-field coverage. `artist` or `title` below 100% means a property was
renamed in Notion and the match needs updating — that failure is otherwise silent.

## Fallback

If the Notion read fails, the run falls back to the last successful snapshot cached at
`curation/.library-cache.json` and notes the staleness on /status. It does not skip the
`records` topic silently. An empty result is treated as a failure, not as an empty
collection, so a permissions change cannot quietly blank the library.

## Manual additions

Artists worth watching that are not (yet) in the collection go here as a plain list.

- (none yet)
