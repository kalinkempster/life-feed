// The curation pass. Two calls to Claude, deliberately separated:
//
//   1. research  — web search, wide, output is prose plus a rough list. This is
//                  the call that needs judgement and a lot of reading.
//   2. structure — turns that into strictly-typed items via structured outputs.
//
// Splitting them means the research call is never fighting a JSON schema while
// it reads, and the schema call never has to be trusted to do research. It also
// keeps the expensive call's system prompt stable enough to cache.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
// Structured outputs live on the beta namespace in @anthropic-ai/sdk 0.70.x.
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { MODEL, TOPICS, KINDS } from "./config.mjs";

// Constructed on first use, not at import: `new Anthropic()` throws when no
// credentials are resolvable, and --no-curate must work without an API key.
let _client = null;
const client = () => (_client ||= new Anthropic());

const CandidateSchema = z.object({
  url: z.string(),
  title: z.string(),
  source: z.string(),
  topic: z.enum(TOPICS),
  kind: z.enum(KINDS),
  summary: z.string(),
  note: z.string(),
  date_published: z.string(),
});

const BatchSchema = z.object({
  items: z.array(CandidateSchema),
});

/** The standing brief. Stable across runs, so it caches. */
function systemPrompt(interests, sources) {
  return [
    "You are the curator for `Life of K²`, a private daily feed with a circulation of one.",
    "You publish for one reader, Kal: an emergency-medicine registrar in Melbourne who",
    "collects records, shoots film, wears vintage workwear, and plays games on PS5 and PC.",
    "",
    "You are held to three standing rules that override everything else:",
    "",
    "1. MERIT ONLY. Publish the best things you actually find, tagged honestly. Never fill",
    "   a topic quota. Returning four excellent items beats returning eight where four are",
    "   padding. The dashboard enforces variety; you do not need to balance topics.",
    "2. REAL URLS ONLY. Every URL must be one you actually saw in a search result. Never",
    "   reconstruct, guess, pattern-match or 'correct' a URL. A fabricated URL that looks",
    "   plausible is the single worst thing you can produce here, because it is invisible",
    "   until it is clicked. If you are not certain of a URL, drop the item.",
    "3. PUBLISH ONCE. Anything already published, listed below, must not be returned again.",
    "",
    "--- THE CURATION BRIEF (curation/interests.md) ---",
    interests,
    "",
    "--- SOURCE WEIGHTING (curation/sources.md) ---",
    sources,
  ].join("\n");
}

function researchPrompt({ today, libraryDigest, publishedUrls, want, poolState }) {
  return [
    `Today is ${today}. Find items to publish in today's edition.`,
    "",
    `Pool state right now: ${poolState.total} items live, ${poolState.timely} of them timely.`,
    `The contract floors are 40 live and 15 timely. ${
      poolState.timely < 15
        ? "The timely floor is NOT met — widen the search: more sources, a longer window, and backfill evergreen from topics that keep well. Do not lower the bar to hit the number."
        : "Both floors are comfortable. Publish only what genuinely earns a slot."
    }`,
    `Aim for roughly ${want} items. Fewer is fine and correct if that is what merit gives you.`,
    "",
    "--- THE RECORD LIBRARY (what he actually owns) ---",
    libraryDigest,
    "",
    "--- ALREADY PUBLISHED (do not return any of these) ---",
    publishedUrls.length ? publishedUrls.join("\n") : "(nothing published yet)",
    "",
    "Search the web now. Work topic by topic. For each candidate you want to publish, give:",
    "  - the exact URL as it appeared in the search result",
    "  - the headline, trimmed to under 70 characters",
    "  - the publisher, under 18 characters",
    "  - topic (one of: " + TOPICS.join(", ") + ") and kind (timely or evergreen)",
    "  - summary: ONE sentence on why it is worth his time. This becomes a hover tooltip",
    "    on the dashboard. Never SEO copy, never a restatement of the headline.",
    "  - note: 2-3 sentences, for the site only. This is where curation shows itself —",
    "    the connection to what he is studying, owns, or lives near. It must NOT begin",
    "    with the summary sentence; it is a different piece of writing, not an extension.",
    "    If you cannot say anything specific, the item is not worth publishing.",
    "  - the article's own publication date (ISO 8601) if you can see it.",
    "",
    "Finish with a plain list of the candidates. Do not worry about JSON formatting.",
  ].join("\n");
}

/**
 * Phase 1 — research with web search.
 * Streams, and resumes `pause_turn` explicitly: a long server-tool turn that pauses
 * would otherwise return a silently truncated answer with no error.
 */
async function research(params) {
  const messages = [
    { role: "user", content: researchPrompt(params) },
  ];

  let text = "";
  let searches = 0;

  for (let turn = 0; turn < 12; turn += 1) {
    const stream = client().messages.stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [
        {
          type: "text",
          text: systemPrompt(params.interests, params.sources),
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 30 }],
      messages,
    });

    const message = await stream.finalMessage();

    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      if (block.type === "web_search_tool_result") searches += 1;
    }

    if (message.stop_reason === "refusal") {
      throw new Error(
        `research refused: ${message.stop_details?.category || "unknown"} — ${
          message.stop_details?.explanation || ""
        }`,
      );
    }

    if (message.stop_reason !== "pause_turn") break;

    // Resume: push the paused turn back and let it carry on.
    messages.push({ role: "assistant", content: message.content });
  }

  return { text, searches };
}

/** Phase 2 — turn the research into strictly-typed items. */
async function structure(researchText, today) {
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["structured-outputs-2025-11-13"],
    output_config: { format: betaZodOutputFormat(BatchSchema) },
    system:
      "You convert a curator's research notes into structured feed items. " +
      "Copy URLs character for character — never repair, complete or normalise them. " +
      "Drop any candidate whose URL is not written out in full in the notes. " +
      "Do not invent items that are not in the notes, and do not merge two into one.",
    messages: [
      {
        role: "user",
        content: [
          `Today is ${today}. Convert these research notes into feed items.`,
          "",
          "Rules for the fields:",
          "- title: under 70 characters.",
          "- source: under 18 characters.",
          "- topic: exactly one of " + TOPICS.join(", "),
          "- kind: timely or evergreen.",
          "- summary: one sentence.",
          "- note: 2-3 sentences, and it must not start with the summary sentence.",
          "- date_published: ISO 8601. Use the article's own date; if the notes do not",
          "  give one, use today's date at 00:00:00Z.",
          "",
          "--- RESEARCH NOTES ---",
          researchText,
        ].join("\n"),
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`structuring refused: ${response.stop_details?.category || "unknown"}`);
  }

  // Validate against the schema here rather than trusting the SDK's parse helper:
  // in @anthropic-ai/sdk 0.70.x that helper only fires on the deprecated top-level
  // `output_format`, so it silently returns null for a correct `output_config`
  // request. Parsing here means the schema is enforced either way.
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!text.trim()) return [];

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`structuring returned unparseable JSON: ${text.slice(0, 200)}`);
  }

  const parsed = BatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `structuring did not match the schema: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
    );
  }
  return parsed.data.items;
}

/**
 * Run a full curation pass.
 * @returns {Promise<{candidates:object[], searches:number, notes:string}>}
 */
export async function curate(params) {
  const { text, searches } = await research(params);
  if (!text.trim()) return { candidates: [], searches, notes: "" };

  const candidates = await structure(text, params.today);
  return { candidates, searches, notes: text };
}
