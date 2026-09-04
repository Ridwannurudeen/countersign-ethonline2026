import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface EvidenceFile {
  readonly schemaVersion: "1";
  readonly guardPublicKeyPrefix: string;
  readonly records: readonly unknown[];
  readonly setupTransactions: readonly unknown[];
  readonly counts: {
    readonly external: {
      readonly reviewCount: number;
      readonly approvalCount: number;
      readonly refusalCount: number;
      readonly distinctPayerAccountCount: number;
    };
    readonly operator: {
      readonly reviewCount: number;
      readonly approvalCount: number;
      readonly refusalCount: number;
    };
  };
}

const pageSource = await readFile(
  new URL("../web/evidence.html", import.meta.url),
  "utf8",
);
const evidence = JSON.parse(
  await readFile(new URL("../web/evidence.json", import.meta.url), "utf8"),
) as EvidenceFile;

test("the checked-in empty state says that no reviews are recorded", () => {
  assert.deepEqual(evidence, {
    schemaVersion: "1",
    guardPublicKeyPrefix: "",
    records: [],
    setupTransactions: [],
    counts: {
      external: {
        reviewCount: 0,
        approvalCount: 0,
        refusalCount: 0,
        distinctPayerAccountCount: 0,
      },
      operator: {
        reviewCount: 0,
        approvalCount: 0,
        refusalCount: 0,
      },
    },
  });
  assert.match(
    pageSource,
    /<p id="empty-state" class="empty" hidden>No reviews recorded yet\.<\/p>/,
  );
  assert.match(
    pageSource,
    /if \(data\.records\.length === 0\) \{\s*elements\.emptyState\.hidden = false;/,
  );
});

test("operator records are explicitly labelled as operator-run trials", () => {
  assert.match(
    pageSource,
    /operator: Object\.freeze\(\{\s*label: "Operator-run",\s*noun: "operator-run trial"/,
  );
  assert.match(pageSource, /These are not external usage/);
  assert.match(
    pageSource,
    /testnet payments are paid protocol trials, not revenue/,
  );
  assert.match(
    pageSource,
    /badge\.textContent = originCopy\[record\.origin\]\.label/,
  );
});

test("operator and external counts have separate data paths", () => {
  assert.match(
    pageSource,
    /const externalRecords = data\.records\.filter\(\s*\(record\) => record\.origin === "external"/,
  );
  assert.match(
    pageSource,
    /const operatorRecords = data\.records\.filter\(\s*\(record\) => record\.origin === "operator"/,
  );
  assert.match(
    pageSource,
    /elements\.externalCount,\s*externalRecords,\s*originCopy\.external/,
  );
  assert.match(
    pageSource,
    /elements\.operatorCount,\s*operatorRecords,\s*originCopy\.operator/,
  );
  assert.doesNotMatch(pageSource, /externalRecords\.concat\(operatorRecords\)/);
  assert.doesNotMatch(pageSource, /operatorRecords\.concat\(externalRecords\)/);
  assert.doesNotMatch(
    pageSource,
    /\[\s*\.\.\.externalRecords\s*,\s*\.\.\.operatorRecords\s*\]/,
  );
});
