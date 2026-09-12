import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// The mirror node returns public_key_prefix as base64 (OpenAPI format: byte).
function mirrorPrefix(publicKeyHex: string): string {
  return Buffer.from(publicKeyHex, "hex").toString("base64");
}

const agentMirrorPrefix = mirrorPrefix("a".repeat(16));
const guardMirrorPrefix = mirrorPrefix("b".repeat(16));

function pendingEvidence() {
  return parseScheduleEvidence({
    creator_account_id: "0.0.2001",
    payer_account_id: "0.0.2001",
    executed_timestamp: null,
    deleted: false,
    signatures: [{ public_key_prefix: agentMirrorPrefix }],
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
      { public_key_prefix: agentMirrorPrefix },
      { public_key_prefix: guardMirrorPrefix },
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
      { public_key_prefix: agentMirrorPrefix },
      { public_key_prefix: guardMirrorPrefix },
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
        signatures: [{ public_key_prefix: agentMirrorPrefix }],
      }),
    /executed_timestamp must be a consensus timestamp/,
  );
});

test("parseScheduleEvidence refuses a prefix that is not canonical base64", () => {
  for (const prefix of ["not base64!!", "AAA", "", "===="]) {
    assert.throws(
      () =>
        parseScheduleEvidence({
          creator_account_id: "0.0.2001",
          payer_account_id: "0.0.2001",
          executed_timestamp: null,
          deleted: false,
          signatures: [{ public_key_prefix: prefix }],
        }),
      /public_key_prefix must be (canonical base64|a non-empty string)/,
      `expected refusal for ${JSON.stringify(prefix)}`,
    );
  }
});

// Regression: the mirror node returns base64, but this code once required hex, which
// aborted the first live run at the evidence step. These are verbatim testnet responses.
const live = JSON.parse(
  readFileSync(new URL("./fixtures/live-mirror-schedules.json", import.meta.url), "utf8"),
) as {
  executed: { scheduleId: string; response: unknown };
  pending: { scheduleId: string; response: unknown };
  agentAccountId: string;
  agentPublicKeyHex: string;
  guardPublicKeyHex: string;
};

const liveSigners = {
  expectedAgentAccountId: live.agentAccountId,
  agentPublicKeyHex: live.agentPublicKeyHex,
  guardPublicKeyHex: live.guardPublicKeyHex,
};

test("INVARIANT: a real executed schedule carries both authorization prefixes", () => {
  const evidence = parseScheduleEvidence(live.executed.response);
  assert.deepEqual(evidence.publicKeyPrefixes, [
    live.agentPublicKeyHex,
    live.guardPublicKeyHex,
  ]);
  assert.equal(evidence.executedTimestamp, "1789211165.040190332");
  assert.doesNotThrow(() =>
    assertExecutedScheduleEvidence(evidence, liveSigners),
  );
});

test("INVARIANT: a real refused schedule proves the guard key is absent", () => {
  const evidence = parseScheduleEvidence(live.pending.response);
  assert.deepEqual(evidence.publicKeyPrefixes, [live.agentPublicKeyHex]);
  assert.equal(evidence.executedTimestamp, null);
  assert.doesNotThrow(() => assertPendingScheduleEvidence(evidence, liveSigners));
  assert.throws(
    () => assertExecutedScheduleEvidence(evidence, liveSigners),
    /executed schedule must have an executed_timestamp/,
  );
});
