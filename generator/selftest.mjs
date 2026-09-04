#!/usr/bin/env node
// Offline self-test. Runs the whole curation path against a local mock of the
// Messages API, so the request shape, the streaming, the pause_turn resume and the
// structured-output parsing are all exercised without a key and without spending a
// curation pass.
//
//   node generator/selftest.mjs
//
// It asserts on the outgoing request body, which is the part that silently breaks:
// a wrong model id, a stale thinking parameter or a mistyped tool type is a 400 at
// 09:00 UTC and an empty edition for the day.

import http from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { MODEL, ROOT } from "./lib/config.mjs";

const captured = [];

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function streamBody({ text, stopReason }) {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ]);
}

const STRUCTURED = {
  items: [
    {
      url: "https://emcrit.org/emcrit/ultrasound-cardiac-arrest/?utm_source=newsletter",
      title: "A mock item that already exists in the archive",
      source: "EMCrit",
      topic: "medicine",
      kind: "timely",
      summary: "Should be filtered out as already published.",
      note: "This exists in the seeded archive, so rule 3 must drop it before verification.",
      date_published: "2026-03-13T00:00:00Z",
    },
    {
      url: "https://first10em.com/",
      title: "A mock item that is new and resolves",
      source: "First10EM",
      topic: "medicine",
      kind: "timely",
      summary: "Should survive and be published.",
      note: "A real, resolvable URL that is not in the archive, so it should verify and publish.",
      date_published: "2026-09-01T00:00:00Z",
    },
    {
      url: "https://emcrit.org/definitely-not-a-real-page-9182/",
      title: "A mock item that 404s",
      source: "EMCrit",
      topic: "medicine",
      kind: "timely",
      summary: "Should be dropped by verification.",
      note: "A plausible-looking URL that does not resolve — exactly the failure mode rule 2 exists for.",
      date_published: "2026-09-01T00:00:00Z",
    },
  ],
};

let researchCalls = 0;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    captured.push({ path: req.url, body });

    const isStructured = Boolean(body.output_config && body.output_config.format);

    if (isStructured) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: JSON.stringify(STRUCTURED) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      );
    }

    // First research turn pauses, to prove the resume path actually works.
    researchCalls += 1;
    const stopReason = researchCalls === 1 ? "pause_turn" : "end_turn";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      streamBody({
        text: researchCalls === 1 ? "Searching…\n" : "Found three candidates.\n",
        stopReason,
      }),
    );
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.ANTHROPIC_API_KEY = "sk-ant-mock";

console.log(`\n  self-test — mock API on 127.0.0.1:${port}\n`);

const { curate } = await import("./lib/curate.mjs");

const result = await curate({
  today: "2026-09-05",
  interests: "# Interests\nmedicine, records, photography.",
  sources: "# Sources\nEMCrit, LITFL.",
  libraryDigest: "12 records.",
  publishedUrls: ["https://emcrit.org/emcrit/ultrasound-cardiac-arrest"],
  want: 8,
  poolState: { total: 18, timely: 5 },
});

// ---------------------------------------------------------------- assertions
const research = captured.filter((c) => !c.body.output_config?.format);
const structure = captured.filter((c) => c.body.output_config?.format);

const checks = [];
const check = (label, fn) => {
  try {
    fn();
    checks.push([true, label]);
  } catch (err) {
    checks.push([false, `${label} — ${err.message}`]);
  }
};

check("research call uses claude-opus-5", () =>
  assert.equal(research[0].body.model, "claude-opus-5"),
);
check("research uses adaptive thinking (not budget_tokens)", () => {
  assert.deepEqual(research[0].body.thinking, { type: "adaptive" });
  assert.equal(research[0].body.thinking.budget_tokens, undefined);
});
check("research sets effort high", () =>
  assert.equal(research[0].body.output_config.effort, "high"),
);
check("research declares the current web_search tool", () => {
  assert.equal(research[0].body.tools.length, 1);
  assert.equal(research[0].body.tools[0].type, "web_search_20260209");
  assert.equal(research[0].body.tools[0].name, "web_search");
});
check("research streams", () => assert.equal(research[0].body.stream, true));
check("system prompt is cacheable", () =>
  assert.deepEqual(research[0].body.system[0].cache_control, { type: "ephemeral" }),
);
check("the brief is actually in the system prompt", () =>
  assert.ok(research[0].body.system[0].text.includes("EMCrit")),
);
check("pause_turn was resumed, not silently truncated", () => {
  assert.equal(research.length, 2, `expected 2 research turns, got ${research.length}`);
  const resumed = research[1].body.messages;
  assert.equal(resumed.at(-1).role, "assistant");
});
check("both research turns' text was kept", () =>
  assert.ok(result.notes.includes("Searching") && result.notes.includes("Found three")),
);
check("structure call sends a JSON schema", () =>
  assert.ok(structure[0].body.output_config.format),
);
check("structure call does not stream or use tools", () => {
  assert.ok(!structure[0].body.stream);
  assert.ok(!structure[0].body.tools);
});
check("structured output parsed into 3 candidates", () =>
  assert.equal(result.candidates.length, 3),
);
check("candidate fields survive parsing", () => {
  assert.equal(result.candidates[1].source, "First10EM");
  assert.equal(result.candidates[1].topic, "medicine");
  assert.equal(result.candidates[1].kind, "timely");
});

// ------------------------------------------------------ signal handling check
// Redis is not reachable here, so exercise the publish logic directly: what a
// `read` dismissal does versus an `irrelevant` one is the part that is easy to get
// backwards and impossible to notice until the site is wrong.
const { selectLive, buildFeed } = await import("./lib/publish.mjs");
const archive = JSON.parse(
  await (await import("node:fs/promises")).readFile("archive/all.json", "utf8"),
);

const readId = archive[0].id;
const goneId = archive[1].id;
const fakeSignals = {
  read: new Set([readId]),
  irrelevant: new Set([goneId]),
};

const liveAfter = selectLive(archive, fakeSignals, new Date("2026-09-05T09:00:00Z"));

check("a `read` item leaves the live feed", () =>
  assert.ok(!liveAfter.some((i) => i.id === readId)),
);
check("an `irrelevant` item leaves the live feed", () =>
  assert.ok(!liveAfter.some((i) => i.id === goneId)),
);
check("everything else stays live", () =>
  assert.equal(liveAfter.length, archive.length - 2),
);
check("evergreen older than 90 days ages out of the live feed", () => {
  const future = selectLive(archive, { read: new Set(), irrelevant: new Set() },
    new Date("2027-06-01T00:00:00Z"));
  assert.ok(
    future.every((i) => i._homepage.kind !== "evergreen"),
    "evergreen should have aged out by then",
  );
});
check("feed.json never carries the site-only note field", () => {
  const feed = buildFeed(liveAfter.slice(0, 3), "2026-09-05T09:00:00Z");
  assert.ok(feed.items.every((i) => i._homepage.note === undefined));
  assert.ok(feed.items.every((i) => i._homepage.image === undefined));
});
check("signals_url is omitted while SIGNALS_ENABLED is unset", () => {
  const feed = buildFeed(liveAfter.slice(0, 3), "2026-09-05T09:00:00Z");
  assert.equal(feed._homepage.signals_url, undefined);
});

// ------------------------------------------------- end-to-end pipeline check
// The mock is still up, so run the real daily run against it in --dry-run mode.
// This exercises the parts that live in run.mjs rather than curate.mjs: rule 3
// (already-published items are filtered before verification), rule 2 (a dead link
// is dropped), and the id-stability guard.
researchCalls = 0;

const e2e = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    ["generator/run.mjs", "--dry-run", "--want=3"],
    {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: "sk-ant-mock",
        UPSTASH_REDIS_REST_URL: "",
        UPSTASH_REDIS_REST_TOKEN: "",
        NOTION_TOKEN: "",
        NOTION_LIBRARY_DB: "",
      },
      cwd: ROOT,
    },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => resolve({ out, code }));
});

check("end-to-end dry run exits cleanly", () =>
  assert.equal(e2e.code, 0, `exit ${e2e.code}:
${e2e.out}`),
);
check("id guard ran over the archive", () =>
  assert.match(e2e.out, /ids\s+\d+ archived, all stable/),
);
check("rule 3 — the already-published candidate was filtered before verifying", () =>
  assert.match(e2e.out, /verifying\s+2 new URLs/),
);
check("rule 2 — the 404 was dropped, the live URL published", () =>
  assert.match(e2e.out, /verified\s+1 publishable · 1 dropped/),
);
check("dry run wrote nothing", () => assert.match(e2e.out, /DRY RUN — would have written/));

// ------------------------------------------- candidate-file path (cloud routine)
// The scheduled routine writes a candidates file instead of calling the API, so
// this path carries the daily edition. It must reject anything malformed loudly
// enough that the session can fix its own file, and it must apply exactly the same
// rules as the API path.
const fsp = await import("node:fs/promises");
const os = await import("node:os");
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lok2-"));

const write = async (name, data) => {
  const f = path.join(tmp, name);
  await fsp.writeFile(f, JSON.stringify(data));
  return f;
};

const runWith = (file, extra = []) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["generator/run.mjs", `--from-candidates=${file}`, "--dry-run", ...extra],
      { cwd: ROOT, env: { ...process.env, UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" } },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ out, code }));
  });

const valid = {
  url: "https://first10em.com/",
  title: "A real, resolvable article",
  source: "First10EM",
  topic: "medicine",
  kind: "timely",
  summary: "One sentence.",
  note: "Two or three sentences of actual curation.",
  date_published: "2026-09-04T00:00:00Z",
};

const badTopic = await runWith(
  await write("topic.json", [{ ...valid, topic: "cooking" }]),
);
check("candidate file: a non-canonical topic is rejected", () => {
  assert.notEqual(badTopic.code, 0);
  assert.match(badTopic.out, /topic "cooking" is not one of/);
});

const badKind = await runWith(await write("kind.json", [{ ...valid, kind: "weekly" }]));
check("candidate file: a bad kind is rejected", () =>
  assert.match(badKind.out, /kind "weekly" must be timely or evergreen/),
);

const missing = await runWith(await write("missing.json", [{ ...valid, note: "" }]));
check("candidate file: an empty note is rejected", () =>
  assert.match(missing.out, /missing or empty note/),
);

const notJson = path.join(tmp, "broken.json");
await fsp.writeFile(notJson, "{not json");
const broken = await runWith(notJson);
check("candidate file: unparseable JSON fails the run, does not publish", () => {
  assert.notEqual(broken.code, 0);
  assert.match(broken.out, /could not read/);
});

const good = await runWith(
  await write("good.json", {
    items: [
      valid,
      { ...valid, url: "https://emcrit.org/emcrit/ultrasound-cardiac-arrest/",
        title: "Already archived" },
      { ...valid, url: "https://emcrit.org/no-such-page-here-1234/", title: "Dead link" },
    ],
  }),
);
check("candidate file: already-published filtered, dead link dropped, rest published", () => {
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /verifying\s+2 new URLs/);
  assert.match(good.out, /verified\s+1 publishable · 1 dropped/);
});
check("candidate file: the run writes nothing under --dry-run", () =>
  assert.match(good.out, /DRY RUN — would have written/),
);

await fsp.rm(tmp, { recursive: true, force: true });

server.close();

let failed = 0;
for (const [ok, label] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed += 1;
}

console.log(
  failed
    ? `\n  ${failed} of ${checks.length} checks FAILED\n`
    : `\n  all ${checks.length} checks passed\n`,
);
process.exitCode = failed ? 1 : 0;
