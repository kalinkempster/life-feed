# Record library

**Source of truth: Notion**, read at the start of every run via `NOTION_TOKEN` +
`NOTION_LIBRARY_DB`. Also visible at https://record-library.vercel.app/?view=library
(client-rendered, so not fetchable — do not scrape it).

The generator uses the library to decide what `records` items are worth publishing:
artists owned, labels owned, and adjacent listening. An artist in the library is a
strong signal; a reissue of something not in it is weak.

## Fallback

If the Notion read fails, the run falls back to the last successful snapshot cached at
`curation/.library-cache.json` and notes the staleness on /status. It does not skip the
`records` topic silently.

## Manual additions

Artists worth watching that are not (yet) in the collection go here as a plain list.

- (none yet)
