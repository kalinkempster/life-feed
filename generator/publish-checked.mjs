#!/usr/bin/env node
// Commit and push the published files — but only if they conform to contract v1.
//
//   npm run publish:checked
//
// This is the gate, and it is deliberately a script rather than a line in a
// prompt. The daily curation is done by an agent session, which is less
// deterministic than a scripted API call; a prompt instruction saying "check
// before you push" is a request, whereas this is a precondition. A session that
// produces a malformed feed fails here and deploys nothing.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/config.mjs";

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });

const die = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

// ------------------------------------------------------------------ 1. gate
console.log("\n  checking contract conformance before publishing…\n");
const check = run(process.execPath, ["generator/verify-feed.mjs"], { stdio: "inherit" });
if (check.status !== 0) {
  die("contract check failed — nothing committed, nothing deployed.");
}

// ------------------------------------------------------------- 2. stage only
// Named paths, never `git add -A`: a curation session may leave scratch files in
// the working tree, and they must not ride along into a deploy.
const PATHS = [
  "site/feed.json",
  "site/site.json",
  "site/status.json",
  "archive",
  "curation/library-snapshot.md",
  "curation/signals-summary.md",
];

// Two of those are conditional: signals-summary.md is only written when Redis
// answers, and the library snapshot only after a Notion sync. `git add` treats an
// unmatched pathspec as fatal, so an absent optional file would fail the publish
// rather than simply not be part of it. Stage what exists; keep the named list.
const staging = PATHS.filter((p) => fs.existsSync(path.join(ROOT, p)));
if (!staging.length) die("none of the publishable paths exist — nothing to stage.");

const add = run("git", ["add", "--", ...staging]);
if (add.status !== 0) die(`git add failed: ${add.stderr.trim()}`);

const staged = run("git", ["diff", "--cached", "--name-only"]).stdout.trim();
if (!staged) {
  console.log("\n  nothing changed — no commit, no deploy.\n");
  process.exit(0);
}

// A last guard: never let a secret reach the remote, whatever put it there.
const diff = run("git", ["diff", "--cached"]).stdout;
if (/\b(sk-ant-[A-Za-z0-9_-]{10,}|ntn_[A-Za-z0-9]{20,})\b/.test(diff)) {
  run("git", ["reset", "--", ...staging]);
  die("a credential appeared in the staged diff — unstaged everything and stopped.");
}

// ---------------------------------------------------------------- 3. publish
const count = (() => {
  try {
    const feed = JSON.parse(
      run("git", ["show", ":site/feed.json"]).stdout || "{}",
    );
    return (feed.items || []).length;
  } catch {
    return "?";
  }
})();

const day = new Date().toISOString().slice(0, 10);
run("git", ["config", "user.name", "life-of-k2 generator"]);
run("git", ["config", "user.email", "kalinkempster@gmail.com"]);

const commit = run("git", ["commit", "-m", `Edition ${day} — ${count} live`]);
if (commit.status !== 0) die(`git commit failed: ${commit.stderr.trim()}`);

const push = run("git", ["push"]);
if (push.status !== 0) die(`git push failed: ${push.stderr.trim()}`);

console.log(`\n  ✓ published — Edition ${day}, ${count} live. Vercel will redeploy.\n`);
console.log(`  Files changed:\n${staged.split("\n").map((f) => `    ${f}`).join("\n")}\n`);
