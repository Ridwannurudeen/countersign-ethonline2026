import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildEvidenceManifest,
  parseEvidenceManifest,
} from "../src/evidence-manifest.ts";

// Evidence events are written by scripts/live-flow.ts as each live run completes.
// The manifest is always regenerated from them, never edited by hand, so the
// counts and mirror-node URLs cannot drift from the recorded runs.
const eventDirectory = resolve("var", "evidence-events");
const manifestPath = resolve("web", "evidence.json");

const events = readdirSync(eventDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) =>
    JSON.parse(readFileSync(resolve(eventDirectory, name), "utf8")),
  );

if (events.length === 0) {
  throw new Error(`no evidence events found in ${eventDirectory}`);
}

const manifest = buildEvidenceManifest(events);
parseEvidenceManifest(JSON.parse(JSON.stringify(manifest)));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`${manifestPath}: ${manifest.records.length} review records`);
console.log(
  `  operator: ${manifest.counts.operator.reviewCount} reviews ` +
    `(${manifest.counts.operator.approvalCount} approved, ` +
    `${manifest.counts.operator.refusalCount} refused)`,
);
console.log(
  `  external: ${manifest.counts.external.reviewCount} reviews ` +
    `from ${manifest.counts.external.distinctPayerAccountCount} payer accounts`,
);
