#!/usr/bin/env node
// Generate the VAPID key pair that identifies this server to push services.
//
//   npm run vapid
//
// The PUBLIC key is written to site/push-key.json and committed — it is public by
// design and the browser needs it to subscribe.
//
// The PRIVATE key is printed once, here, and never written to disk. Paste it into
// GitHub → Settings → Secrets → Actions as VAPID_PRIVATE_KEY. If it is lost,
// re-run this: every existing subscription stops working and has to be re-enabled,
// which for a circulation of one means tapping a toggle again.

import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { SITE } from "./lib/config.mjs";

const target = path.join(SITE, "push-key.json");

if (fs.existsSync(target) && !process.argv.includes("--force")) {
  const existing = JSON.parse(fs.readFileSync(target, "utf8"));
  console.log(`\n  A key pair already exists.\n`);
  console.log(`  public key: ${existing.publicKey}\n`);
  console.log(`  Re-running would invalidate every existing subscription. If that is`);
  console.log(`  really what you want: npm run vapid -- --force\n`);
  process.exit(0);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

fs.writeFileSync(
  target,
  JSON.stringify(
    {
      publicKey,
      subject: "mailto:kalinkempster@gmail.com",
      generated: new Date().toISOString(),
      note: "Public half of the VAPID pair. Safe to commit. The private half lives only in the VAPID_PRIVATE_KEY Actions secret.",
    },
    null,
    2,
  ) + "\n",
);

console.log(`\n  Wrote the public key to site/push-key.json — commit it.\n`);
console.log(`  Now add this as a GitHub Actions secret named VAPID_PRIVATE_KEY:\n`);
console.log(`  ────────────────────────────────────────────────────────────`);
console.log(`  ${privateKey}`);
console.log(`  ────────────────────────────────────────────────────────────\n`);
console.log(`  github.com/kalinkempster/life-feed/settings/secrets/actions\n`);
console.log(`  It is not saved anywhere. Copy it now; this is the only time it prints.\n`);
