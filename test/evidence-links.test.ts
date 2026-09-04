import assert from "node:assert/strict";
import test from "node:test";

import {
  accountMirrorNodeUrl,
  assertExecutedScheduleEvidence,
  assertPendingScheduleEvidence,
  parseScheduleEvidence,
  scheduleMirrorNodeUrl,
} from "../src/evidence-links.ts";

const agentPublicKeyHex = "a".repeat(64);
const guardPublicKeyHex = "b".repeat(64);

function pendingEvidence() {
  return parseScheduleEvidence({
    creator_account_id: "0.0.2001",
    payer_account_id: "0.0.2001",
    executed_timestamp: null,
    deleted: false,
    signatures: [{ public_key_prefix: "a".repeat(16) }],
    ignoredMirrorField: "not part of the evidence contract",
  });
}

const expectedSigners = {
  expectedAgentAccountId: "0.0.2001",
  agentPublicKeyHex,
  guardPublicKeyHex,
};

test("mirror-node links use the canonical testnet evidence endpoints", () => {
  assert.equal(
    scheduleMirrorNodeUrl("0.0.7001"),
    "https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.7001",
  );
  assert.equal(
    accountMirrorNodeUrl("0.0.1001"),
    "https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.1001",
  );
});

test("parseScheduleEvidence keeps only the independently checkable fields", () => {
  assert.deepEqual(pendingEvidence(), {
    creatorAccountId: "0.0.2001",
    payerAccountId: "0.0.2001",
    executedTimestamp: null,
    deleted: false,
    publicKeyPrefixes: ["a".repeat(16)],
  });
});

test("invariant: pending evidence has the agent prefix and no guard prefix", () => {
  assert.doesNotThrow(() =>
    assertPendingScheduleEvidence(pendingEvidence(), expectedSigners),
  );

  const guardPresent = parseScheduleEvidence({
    creator_account_id: "0.0.2001",
    payer_account_id: "0.0.2001",
    executed_timestamp: null,
    deleted: false,
    signatures: [
      { public_key_prefix: "a".repeat(16) },
      { public_key_prefix: "b".repeat(16) },
    ],
  });
  assert.throws(
    () => assertPendingScheduleEvidence(guardPresent, expectedSigners),
    /guard key prefix must be absent/,
  );
});

test("invariant: executed evidence has both authorization prefixes", () => {
  const evidence = parseScheduleEvidence({
    creator_account_id: "0.0.2001",
    payer_account_id: "0.0.2001",
    executed_timestamp: "1788509000.000000001",
    deleted: false,
    signatures: [
      { public_key_prefix: "a".repeat(16) },
      { public_key_prefix: "b".repeat(16) },
    ],
  });

  assert.doesNotThrow(() =>
    assertExecutedScheduleEvidence(evidence, expectedSigners),
  );
});

test("parseScheduleEvidence refuses an invalid executed timestamp", () => {
  assert.throws(
    () =>
      parseScheduleEvidence({
        creator_account_id: "0.0.2001",
        payer_account_id: "0.0.2001",
        executed_timestamp: "not-a-consensus-timestamp",
        deleted: false,
        signatures: [{ public_key_prefix: "a".repeat(16) }],
      }),
    /executed_timestamp must be a consensus timestamp/,
  );
});
