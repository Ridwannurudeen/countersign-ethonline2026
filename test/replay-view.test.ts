import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseEvidenceManifest } from "../src/evidence-manifest.ts";

const pageSource = await readFile(
  new URL("../web/replay.html", import.meta.url),
  "utf8",
);
const fixture = parseEvidenceManifest(
  JSON.parse(
    await readFile(
      new URL("./fixtures/replay-evidence.json", import.meta.url),
      "utf8",
    ),
  ),
);

test("a refused chain renders ScheduleSign and execution as never happened", () => {
  assert.equal(fixture.records[0]?.outcome, "refused");
  assert.match(
    pageSource,
    /record\.outcome === "refused"[\s\S]*ScheduleSign[\s\S]*Never happened[\s\S]*Execution[\s\S]*Never happened/,
  );
});

test("mirror-derived steps are distinct from manifest-derived steps", () => {
  assert.match(pageSource, /data-source="manifest">Manifest record</);
  assert.match(pageSource, /data-source="live">Live mirror node</);
  assert.match(pageSource, /fetch\(record\.mirrorNodeUrl/);
  assert.match(pageSource, /Could not verify/);
});

test("a guard signature requires an exact mirror-node key-prefix match", () => {
  assert.match(
    pageSource,
    /signaturePrefixes\.includes\(\s*currentManifest\.guardPublicKeyPrefix,?\s*\)/,
  );
  assert.doesNotMatch(pageSource, /startsWith\(currentManifest\.guardPublicKeyPrefix\)/);
});

test("an operator-origin record is labelled operator-run", () => {
  assert.equal(fixture.records[0]?.origin, "operator");
  assert.match(
    pageSource,
    /operator: Object\.freeze\(\{ label: "Operator-run"/,
  );
  assert.match(pageSource, /originCopy\[record\.origin\]\.label/);
});

test("the empty state renders the no-records message", () => {
  assert.match(pageSource, /No reviews recorded yet\./);
  assert.match(
    pageSource,
    /if \(manifest\.records\.length === 0\)[\s\S]*emptyState\.hidden = false/,
  );
});
