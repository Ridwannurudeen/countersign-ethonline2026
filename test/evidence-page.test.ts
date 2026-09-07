import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  executePage,
  manifestWithRecords,
  mirrorSchedule,
  reviewRecord,
} from "./page-harness.ts";

interface EvidenceFile {
  readonly schemaVersion: "1";
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

test("INVARIANT: pending evidence must make no absence claim", async () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  const page = await executePage("evidence", manifestWithRecords(), () => promise);
  assert.doesNotMatch(
    page.element("#operator-list").textContent,
    /Refusal verified|Absent from|executed_timestamp is null/,
  );
  resolve(Response.json(mirrorSchedule));
  await page.done;
  assert.match(page.element("#operator-list").textContent, /Refusal verified by absence/);
});

for (const [name, patch] of [
  ["non-mirror URL", { mirrorNodeUrl: "https://example.com/schedule" }],
  ["relative URL", { mirrorNodeUrl: "./evidence.json" }],
  [
    "another schedule URL",
    { mirrorNodeUrl: reviewRecord.mirrorNodeUrl.replace("7001", "7002") },
  ],
  ["URL query", { mirrorNodeUrl: `${reviewRecord.mirrorNodeUrl}?limit=1` }],
  ["URL fragment", { mirrorNodeUrl: `${reviewRecord.mirrorNodeUrl}#schedule` }],
  [
    "URL credentials",
    { mirrorNodeUrl: reviewRecord.mirrorNodeUrl.replace("https://", "https://user@") },
  ],
  [
    "noncanonical schedule ID",
    {
      scheduleId: "0.0.07001",
      mirrorNodeUrl: reviewRecord.mirrorNodeUrl.replace("7001", "07001"),
    },
  ],
  ["missing guard identity", { guardPublicKeyPrefix: undefined }],
  ["malformed guard identity", { guardPublicKeyPrefix: "not-hex" }],
  ["odd-length guard identity", { guardPublicKeyPrefix: "abc" }],
  ["empty guard identity", { guardPublicKeyPrefix: "" }],
] as const) {
  test(`INVARIANT: ${name} must never establish evidence provenance`, async () => {
    const page = await executePage(
      "evidence",
      manifestWithRecords([{ ...reviewRecord, ...patch }] as typeof reviewRecord[]),
      async () => Response.json(mirrorSchedule),
    );
    await page.done;
    assert.match(page.element("#page-status").textContent, /Could not verify/);
    assert.deepEqual(page.requests, ["./evidence.json"]);
    assert.equal(page.element("#operator-list").children.length, 0);
  });
}

for (const [name, patch] of [
  ["malformed signature", { signatures: [{ public_key_prefix: "not-hex" }] }],
  ["odd-length signature", { signatures: [{ public_key_prefix: "abc" }] }],
  ["empty signature", { signatures: [{ public_key_prefix: "" }] }],
  ["empty timestamp", { executed_timestamp: "" }],
  ["malformed timestamp", { executed_timestamp: "123.4" }],
  ["mismatched memo", { memo: "c".repeat(64) }],
  ["missing memo", { memo: undefined }],
] as const) {
  test(`INVARIANT: ${name} must not produce verified evidence facts`, async () => {
    const page = await executePage(
      "evidence",
      manifestWithRecords(),
      async () => Response.json({ ...mirrorSchedule, ...patch }),
    );
    await page.done;
    assert.match(page.element("#operator-list").textContent, /Could not verify/);
    assert.doesNotMatch(
      page.element("#operator-list").textContent,
      /Refusal verified|Absent from/,
    );
  });
}

for (const status of [404, 429, 500, 503]) {
  test(`INVARIANT: HTTP ${status} must never establish evidence absence`, async () => {
    const page = await executePage(
      "evidence",
      manifestWithRecords(),
      async () => new Response(null, { status }),
    );
    await page.done;
    assert.match(page.element("#operator-list").textContent, /Could not verify/);
    assert.doesNotMatch(
      page.element("#operator-list").textContent,
      /Refusal verified|Absent from/,
    );
  });
}

test("INVARIANT: rejected requests must not establish evidence absence", async () => {
  const page = await executePage("evidence", manifestWithRecords(), async () => {
    throw new Error("request failed");
  });
  await page.done;
  assert.match(page.element("#operator-list").textContent, /Could not verify/);
  assert.doesNotMatch(page.element("#operator-list").textContent, /Refusal verified/);
});

test("INVARIANT: contradictory evidence must override the recorded refusal", async () => {
  const page = await executePage("evidence", manifestWithRecords(), async () => Response.json({
    ...mirrorSchedule,
    executed_timestamp: "1788509000.000000001",
    signatures: [{ public_key_prefix: reviewRecord.guardPublicKeyPrefix.toUpperCase() }],
  }));
  await page.done;
  const text = page.element("#operator-list").textContent;
  assert.match(text, /Present in signatures/);
  assert.match(text, /1788509000.000000001/);
  assert.doesNotMatch(text, /Refusal verified/);
});

test("INVARIANT: evidence records must interpret signatures with their own guard identities", async () => {
  const second = {
    ...reviewRecord,
    scheduleId: "0.0.7002",
    mirrorNodeUrl: reviewRecord.mirrorNodeUrl.replace("7001", "7002"),
    guardPublicKeyPrefix: "cccccccccccccccc",
  };
  const records = [reviewRecord, second];
  const page = await executePage("evidence", manifestWithRecords(records), async (url) => {
    const record = records.find((candidate) => candidate.mirrorNodeUrl === url)!;
    return Response.json({
      ...mirrorSchedule,
      signatures: [{ public_key_prefix: record.guardPublicKeyPrefix }],
    });
  });
  await page.done;
  assert.equal(page.element("#operator-list").children.length, 2);
  for (const item of page.element("#operator-list").children) {
    assert.match(item.textContent, /Present in signatures/);
    assert.doesNotMatch(item.textContent, /Refusal verified|Absent from/);
  }
});
