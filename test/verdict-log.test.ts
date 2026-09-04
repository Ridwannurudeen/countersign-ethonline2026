import assert from "node:assert/strict";
import test from "node:test";

import { Client, PrivateKey } from "@hiero-ledger/sdk";

import {
  createHederaVerdictTopicTransport,
  openVerdictLog,
  validateVerdictTopicInfo,
  type VerdictRecord,
  type VerdictTopicInfo,
  type VerdictTopicTransport,
} from "../src/verdict-log.ts";

const approvedRecord: VerdictRecord = {
  outcome: "approved",
  scheduleId: "0.0.7001",
  mandateDigest: "a".repeat(64),
  settlementId: "settlement-1",
  tenantId: "treasury-1",
  agentIdentifier: "uaid:aid:agent;uid=0;registry=countersign",
  guardIdentifier: "uaid:aid:guard;uid=0;registry=countersign",
};

function transport() {
  const calls: string[] = [];
  const messages: string[] = [];
  const value: VerdictTopicTransport = {
    async lookupTopic(topicId) {
      calls.push(`lookup:${topicId}`);
    },
    async createTopic() {
      calls.push("create");
      return "0.0.8001";
    },
    async submitMessage(topicId, message) {
      calls.push(`submit:${topicId}`);
      messages.push(message);
      return "12";
    },
  };

  return { calls, messages, value };
}

function verdictTopicInfo(
  overrides: Partial<VerdictTopicInfo> = {},
): VerdictTopicInfo {
  return {
    topicId: { toString: () => "0.0.8002" },
    topicMemo: "Countersign review verdicts",
    adminKey: null,
    submitKey: PrivateKey.generateED25519().publicKey,
    feeScheduleKey: null,
    customFees: null,
    ...overrides,
  };
}

test("validateVerdictTopicInfo accepts an immutable fee-free topic", () => {
  const operatorPublicKey = PrivateKey.generateED25519().publicKey;

  for (const customFees of [null, []] as const) {
    assert.doesNotThrow(() =>
      validateVerdictTopicInfo(
        verdictTopicInfo({ submitKey: operatorPublicKey, customFees }),
        "0.0.8002",
        operatorPublicKey,
      ),
    );
  }
});

test("validateVerdictTopicInfo refuses a topic with an admin key", () => {
  const operatorPublicKey = PrivateKey.generateED25519().publicKey;

  assert.throws(
    () =>
      validateVerdictTopicInfo(
        verdictTopicInfo({
          adminKey: operatorPublicKey,
          submitKey: operatorPublicKey,
        }),
        "0.0.8002",
        operatorPublicKey,
      ),
    /must not have an admin key/,
  );
});

test("validateVerdictTopicInfo refuses a topic with a fee schedule key", () => {
  const operatorPublicKey = PrivateKey.generateED25519().publicKey;

  assert.throws(
    () =>
      validateVerdictTopicInfo(
        verdictTopicInfo({
          submitKey: operatorPublicKey,
          feeScheduleKey: operatorPublicKey,
        }),
        "0.0.8002",
        operatorPublicKey,
      ),
    /must not have a fee schedule key/,
  );
});

test("validateVerdictTopicInfo refuses a topic with custom fees", () => {
  const operatorPublicKey = PrivateKey.generateED25519().publicKey;

  assert.throws(
    () =>
      validateVerdictTopicInfo(
        verdictTopicInfo({
          submitKey: operatorPublicKey,
          customFees: [{}],
        }),
        "0.0.8002",
        operatorPublicKey,
      ),
    /must not charge custom fees/,
  );
});

test("openVerdictLog looks up the configured verdict topic", async () => {
  const fixture = transport();

  await openVerdictLog(fixture.value, "0.0.8002");

  assert.deepEqual(fixture.calls, ["lookup:0.0.8002"]);
});

test("openVerdictLog creates a verdict topic when none is configured", async () => {
  const fixture = transport();

  await openVerdictLog(fixture.value);

  assert.deepEqual(fixture.calls, ["create"]);
});

test("VerdictLog records an approved review and returns its mirror-node URL", async () => {
  const fixture = transport();
  const log = await openVerdictLog(fixture.value, "0.0.8002");

  const receipt = await log.record(approvedRecord);

  assert.deepEqual(JSON.parse(fixture.messages[0] ?? ""), {
    v: 1,
    outcome: "approved",
    scheduleId: "0.0.7001",
    mandateDigest: "a".repeat(64),
    settlementId: "settlement-1",
    tenantId: "treasury-1",
    participants: {
      agent: "uaid:aid:agent;uid=0;registry=countersign",
      guard: "uaid:aid:guard;uid=0;registry=countersign",
    },
  });
  assert.deepEqual(receipt, {
    topicId: "0.0.8002",
    sequenceNumber: "12",
    mirrorNodeUrl:
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.8002/messages/12",
  });
});

test("VerdictLog records a refused review as evidence", async () => {
  const fixture = transport();
  const log = await openVerdictLog(fixture.value, "0.0.8002");

  await log.record({ ...approvedRecord, outcome: "refused" });

  const message = JSON.parse(fixture.messages[0] ?? "") as {
    outcome?: unknown;
  };
  assert.equal(message.outcome, "refused");
  assert.deepEqual(fixture.calls, ["lookup:0.0.8002", "submit:0.0.8002"]);
});

test("createHederaVerdictTopicTransport rejects a client without an operator key", () => {
  const client = Client.forTestnet();
  try {
    assert.throws(
      () => createHederaVerdictTopicTransport(client),
      /operator key is required/,
    );
  } finally {
    client.close();
  }
});
