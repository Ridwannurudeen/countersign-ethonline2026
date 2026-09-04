import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildEvidenceManifest,
  parseEvidenceManifest,
  type EvidenceEvent,
  type ReviewEvidenceInput,
} from "../src/evidence-manifest.ts";

const review: ReviewEvidenceInput = {
  kind: "review",
  origin: "external",
  scheduleId: "0.0.7001",
  outcome: "approved",
  decidingInvariant: "recipient is on the mandate allowlist",
  mandateDigest: "a".repeat(64),
  mandatePolicy: {
    asset: { kind: "hbar" },
    recipientAllowlist: ["0.0.1002"],
    maxAmountTinybars: "50000000",
    validFromEpochSeconds: "1788508800",
    expiresAtEpochSeconds: "1788512400",
  },
  settlementId: "0.0.7162784@1788509000.000000001",
  settlementAmountTinybars: "1000000",
  paymentPayerAccountId: "0.0.8001",
};

test("INVARIANT: a record without an explicit origin must be refused", () => {
  const { origin: _origin, ...withoutOrigin } = review;

  assert.throws(
    () => buildEvidenceManifest("ab12", [withoutOrigin as unknown as EvidenceEvent]),
    /origin must be operator or external/,
  );
});

test("INVARIANT: operator and external counts must never be summed into one field", () => {
  const manifest = buildEvidenceManifest("ab12", [
    review,
    { ...review, scheduleId: "0.0.7002", outcome: "refused" },
    {
      ...review,
      origin: "operator",
      scheduleId: "0.0.7003",
      paymentPayerAccountId: "0.0.8002",
    },
  ]);

  assert.deepEqual(manifest.counts, {
    external: {
      reviewCount: 2,
      approvalCount: 1,
      refusalCount: 1,
      distinctPayerAccountCount: 1,
    },
    operator: {
      reviewCount: 1,
      approvalCount: 1,
      refusalCount: 0,
    },
  });
  assert.equal("total" in manifest.counts, false);
  assert.equal("reviewCount" in manifest.counts, false);
  assert.equal("approvalCount" in manifest.counts, false);
  assert.equal("refusalCount" in manifest.counts, false);
});

test("a setup transaction is not counted as a review", () => {
  const manifest = buildEvidenceManifest("", [
    {
      kind: "setup",
      origin: "operator",
      transactionId: "0.0.8001@1788508000.000000001",
      purpose: "account creation",
    },
  ]);

  assert.equal(manifest.records.length, 0);
  assert.equal(manifest.setupTransactions.length, 1);
  assert.equal(manifest.counts.external.reviewCount, 0);
  assert.equal(manifest.counts.operator.reviewCount, 0);
});

test("the empty manifest validates and exposes only separated zero counts", () => {
  const manifest = buildEvidenceManifest("", []);

  assert.deepEqual(parseEvidenceManifest(manifest), manifest);
  assert.deepEqual(manifest.counts, {
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
  });
});

test("manifest validation rejects a non-string guard public-key prefix", () => {
  const manifest = buildEvidenceManifest("", []);

  assert.throws(
    () =>
      parseEvidenceManifest({
        ...manifest,
        guardPublicKeyPrefix: 12,
      }),
    /guardPublicKeyPrefix must be a string/,
  );
});

test("manifest validation does not depend on count-field property order", () => {
  const manifest = buildEvidenceManifest("", []);

  assert.deepEqual(
    parseEvidenceManifest({
      ...manifest,
      counts: {
        operator: {
          refusalCount: 0,
          approvalCount: 0,
          reviewCount: 0,
        },
        external: {
          distinctPayerAccountCount: 0,
          refusalCount: 0,
          approvalCount: 0,
          reviewCount: 0,
        },
      },
    }),
    manifest,
  );
});

test("the produced JSON satisfies the evidence page contract", async () => {
  const pageSource = await readFile(
    new URL("../web/evidence.html", import.meta.url),
    "utf8",
  );
  const checkedIn = parseEvidenceManifest(
    JSON.parse(
      await readFile(new URL("../web/evidence.json", import.meta.url), "utf8"),
    ),
  );
  const produced = buildEvidenceManifest("", []);

  assert.deepEqual(checkedIn, produced);
  assert.match(pageSource, /data\.records/);
  assert.match(pageSource, /data\.guardPublicKeyPrefix/);
  assert.match(pageSource, /No reviews recorded yet\./);
});

test("review records carry canonical schedule and payer mirror links", () => {
  const [record] = buildEvidenceManifest("ab12", [review]).records;

  assert.equal(
    record?.mirrorNodeUrl,
    "https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.7001",
  );
  assert.equal(
    record?.paymentPayerMirrorNodeUrl,
    "https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.8001",
  );
});
