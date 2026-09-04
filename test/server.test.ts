import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

import { proto } from "@hiero-ledger/proto";
import { Client, KeyList, PrivateKey } from "@hiero-ledger/sdk";

import {
  canonicalMandateBytes,
  mandateDigest,
  type Mandate,
} from "../src/mandate.ts";
import type {
  ReviewCheck,
  ReviewableScheduleInfo,
} from "../src/review-schedule.ts";
import {
  ReplayStoreContentionError,
  type CompletedMandateReview,
} from "../src/replay-store.ts";
import {
  MAX_REVIEW_BODY_BYTES,
  createProductionReviewServer,
  createReviewServer,
  type ProductionReviewServerConfig,
  type ProductionReviewServerServices,
  type ReviewServerDependencies,
} from "../src/server.ts";
import type { VerdictRecord } from "../src/verdict-log.ts";

const ownerKey = PrivateKey.generateED25519();
const agentKey = PrivateKey.generateED25519().publicKey;
const guardKey = PrivateKey.generateED25519().publicKey;
const operationalKey = PrivateKey.generateED25519().publicKey;
const treasuryKey = new KeyList(
  [ownerKey.publicKey, new KeyList([agentKey, guardKey], 2)],
  1,
);

const mandate: Mandate = {
  tenantId: "treasury-1",
  nonce: "7",
  treasuryAccountId: "0.0.1001",
  recipientAllowlist: ["0.0.1002"],
  maxAmountTinybars: "50000000",
  validFromEpochSeconds: "1788508800",
  expiresAtEpochSeconds: "1788512400",
};

const digest = mandateDigest(mandate);

function signedMandateEnvelope(value: Mandate = mandate) {
  return {
    mandate: value,
    signature: Buffer.from(ownerKey.sign(canonicalMandateBytes(value))).toString(
      "base64url",
    ),
  };
}

function requestBody() {
  return {
    tenantId: mandate.tenantId,
    mandateEnvelope: signedMandateEnvelope(),
    scheduleId: "0.0.7001",
  };
}

function numericAccount(accountNum: string): proto.IAccountID {
  return {
    shardNum: BigInt(0),
    realmNum: BigInt(0),
    accountNum: BigInt(accountNum),
  } as unknown as proto.IAccountID;
}

function adjustment(accountNum: string, amount: string): proto.IAccountAmount {
  return {
    accountID: numericAccount(accountNum),
    amount: BigInt(amount),
    isApproval: false,
  } as unknown as proto.IAccountAmount;
}

function schedule(
  overrides: Record<string, unknown> = {},
): ReviewableScheduleInfo {
  return {
    scheduleId: { toString: () => "0.0.7001" },
    creatorAccountId: { toString: () => "0.0.2001" },
    payerAccountId: { toString: () => "0.0.2001" },
    schedulableTransactionBody: {
      transactionFee: BigInt("100000000"),
      memo: digest,
      cryptoTransfer: {
        transfers: {
          accountAmounts: [
            adjustment("1001", "-25000000"),
            adjustment("1002", "25000000"),
          ],
        },
        tokenTransfers: [],
      },
      maxCustomFees: [],
    },
    signers: new KeyList([agentKey]),
    scheduleMemo: digest,
    adminKey: null,
    expirationTime: { seconds: BigInt("1788512000"), nanos: BigInt(0) },
    executed: null,
    deleted: null,
    waitForExpiry: false,
    ...overrides,
  } as unknown as ReviewableScheduleInfo;
}

function resolvedSchedule(info: ReviewableScheduleInfo = schedule()) {
  return {
    info,
    context: {
      expectedAgentAccountId: "0.0.2001",
      treasuryAccountId: "0.0.1001",
      agentPublicKey: agentKey,
      guardPublicKey: guardKey,
      protocolMaxFeeTinybars: "100000000",
      nowEpochSeconds: "1788509000",
      networkVersions: {
        protobuf: { major: 0, minor: 64, patch: 0 },
        services: { major: 0, minor: 64, patch: 0 },
      },
      allowedNetworkVersions: {
        protobuf: "0.64.0",
        services: "0.64.0",
      },
    },
  };
}

interface Harness {
  dependencies: ReviewServerDependencies;
  events: string[];
  verdicts: VerdictRecord[];
  completions: CompletedMandateReview[];
}

function harness(
  overrides: Partial<ReviewServerDependencies> = {},
): Harness {
  const events: string[] = [];
  const verdicts: VerdictRecord[] = [];
  const completions: CompletedMandateReview[] = [];
  const dependencies: ReviewServerDependencies = {
    ownerPublicKey: ownerKey.publicKey,
    paymentGate: {
      async review() {
        events.push("payment");
        return {
          paid: true,
          settlementId: "0.0.8001@1788509000.000000001",
          responseHeaders: { "payment-response": "settled" },
        };
      },
    },
    async resolveSchedule() {
      events.push("resolve");
      return resolvedSchedule();
    },
    lookupCompletedReview() {
      events.push("lookup");
      return null;
    },
    reserveNonce() {
      events.push("reserve");
      return { status: "reserved" };
    },
    async submitScheduleApproval() {
      events.push("submit");
    },
    completeNonce(_reservation, completion) {
      events.push("complete");
      completions.push(completion);
    },
    verdictLog: {
      async record(record) {
        events.push("record");
        verdicts.push(record);
        return {
          topicId: "0.0.9001",
          sequenceNumber: "4",
          mirrorNodeUrl:
            "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/4",
        };
      },
    },
    participantIdentifiers: {
      agent: "uaid:aid:agent;nativeId=hedera:testnet:0.0.2001",
      guard: "uaid:aid:guard;nativeId=hedera:testnet:0.0.3001",
    },
    ...overrides,
  };

  return { dependencies, events, verdicts, completions };
}

async function postReview(
  dependencies: ReviewServerDependencies,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const server = createReviewServer(dependencies);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    return { response, json };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error == null ? resolve() : reject(error)));
    });
  }
}

test("POST /review rejects unknown top-level fields before payment", async () => {
  const state = harness();
  const { response, json } = await postReview(state.dependencies, {
    ...requestBody(),
    untrustedInstruction: "ignored",
  });

  assert.equal(response.status, 400);
  assert.match(String(json.error), /unknown request field/);
  assert.deepEqual(state.events, []);
});

test("POST /review rejects a tenant binding mismatch before payment", async () => {
  const state = harness();
  const { response, json } = await postReview(state.dependencies, {
    ...requestBody(),
    tenantId: "treasury-2",
  });

  assert.equal(response.status, 400);
  assert.match(String(json.error), /tenantId/);
  assert.deepEqual(state.events, []);
});

test("POST /review rejects a non-canonical ScheduleID before payment", async () => {
  const state = harness();
  const { response, json } = await postReview(state.dependencies, {
    ...requestBody(),
    scheduleId: "00.0.7001",
  });

  assert.equal(response.status, 400);
  assert.match(String(json.error), /canonical numeric Hedera ScheduleID/);
  assert.deepEqual(state.events, []);
});

test("POST /review rejects an invalid mandate signature before payment", async () => {
  const state = harness();
  const differentOwner = PrivateKey.generateED25519();
  const input = requestBody();
  input.mandateEnvelope.signature = Buffer.from(
    differentOwner.sign(canonicalMandateBytes(mandate)),
  ).toString("base64url");

  const { response, json } = await postReview(state.dependencies, input);

  assert.equal(response.status, 401);
  assert.match(String(json.error), /mandate signature/);
  assert.deepEqual(state.events, []);
});

test("POST /review limits the request body before payment", async () => {
  const state = harness();
  const oversizedBody = JSON.stringify({
    ...requestBody(),
    padding: "x".repeat(MAX_REVIEW_BODY_BYTES),
  });

  const { response, json } = await postReview(state.dependencies, oversizedBody);

  assert.equal(response.status, 413);
  assert.match(String(json.error), /request body/);
  assert.deepEqual(state.events, []);
});

test("POST /review closes an oversized chunked body before its terminating chunk", async () => {
  const state = harness();
  const server = createReviewServer(state.dependencies);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, "127.0.0.1");
      const responseChunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("server did not stop reading the oversized body"));
      }, 1_000);

      socket.once("connect", () => {
        const oversizedChunk = "x".repeat(MAX_REVIEW_BODY_BYTES + 1);
        socket.write(
          "POST /review HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${address.port}\r\n` +
            "Content-Type: application/json\r\n" +
            "Transfer-Encoding: chunked\r\n" +
            "Connection: keep-alive\r\n\r\n" +
            `${oversizedChunk.length.toString(16)}\r\n${oversizedChunk}\r\n`,
        );
      });
      socket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
      socket.once("error", reject);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve(Buffer.concat(responseChunks).toString("utf8"));
      });
    });

    assert.match(rawResponse, /^HTTP\/1\.1 413 /);
    assert.match(rawResponse, /Connection: close/i);
    assert.deepEqual(state.events, []);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error == null ? resolve() : reject(error)));
    });
  }
});

test("POST /review returns the payment challenge without resolving consensus", async () => {
  const state = harness({
    paymentGate: {
      async review(header) {
        state.events.push(`payment:${header ?? "absent"}`);
        return {
          paid: false,
          status: 402,
          headers: { "payment-required": "challenge" },
          body: { error: "payment required" },
        };
      },
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody());

  assert.equal(response.status, 402);
  assert.equal(response.headers.get("payment-required"), "challenge");
  assert.deepEqual(json, { error: "payment required" });
  assert.deepEqual(state.events, ["payment:absent"]);
});

test("POST /review fails closed when payment verification errors", async () => {
  const state = harness({
    paymentGate: {
      async review() {
        state.events.push("payment");
        throw new Error("facilitator unavailable");
      },
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody());

  assert.equal(response.status, 500);
  assert.deepEqual(json, { error: "internal server error" });
  assert.deepEqual(state.events, ["payment"]);
});

test("POST /review retains settlement headers when consensus resolution errors", async () => {
  const state = harness({
    async resolveSchedule() {
      state.events.push("resolve");
      throw new Error("consensus unavailable");
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody());

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("payment-response"), "settled");
  assert.deepEqual(json, { error: "internal server error" });
  assert.deepEqual(state.events, ["payment", "lookup", "resolve"]);
});

test("POST /review records a paid authorization refusal without reserving", async () => {
  const reviewChecks: ReviewCheck[] = [];
  const state = harness({
    async resolveSchedule() {
      state.events.push("resolve");
      return resolvedSchedule(
        schedule({
          schedulableTransactionBody: {
            transactionFee: BigInt("100000000"),
            memo: digest,
            cryptoTransfer: {
              transfers: {
                accountAmounts: [
                  adjustment("1001", "-25000000"),
                  adjustment("1003", "25000000"),
                ],
              },
              tokenTransfers: [],
            },
            maxCustomFees: [],
          },
        }),
      );
    },
    reviewObserver: {
      onReviewCheck(check) {
        reviewChecks.push(check);
      },
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody(), {
    "payment-signature": "paid-request",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("payment-response"), "settled");
  assert.deepEqual(json, {
    outcome: "refused",
    reason: "recipient is outside the mandate allowlist",
    scheduleId: "0.0.7001",
    mandateDigest: digest,
    settlementId: "0.0.8001@1788509000.000000001",
    mirrorNodeUrl:
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/4",
  });
  assert.deepEqual(state.events, ["payment", "lookup", "resolve", "record"]);
  assert.deepEqual(reviewChecks.at(-1), {
    invariant: "recipient is on the mandate allowlist",
    passed: false,
  });
  assert.deepEqual(state.verdicts, [
    {
      outcome: "refused",
      scheduleId: "0.0.7001",
      mandateDigest: digest,
      settlementId: "0.0.8001@1788509000.000000001",
      tenantId: "treasury-1",
      agentIdentifier:
        "uaid:aid:agent;nativeId=hedera:testnet:0.0.2001",
      guardIdentifier:
        "uaid:aid:guard;nativeId=hedera:testnet:0.0.3001",
    },
  ]);
});

test("POST /review records a replay refusal without submitting approval", async () => {
  const state = harness({
    reserveNonce() {
      state.events.push("reserve");
      return {
        status: "refused",
        reason: "nonce must be greater than the tenant high-water mark",
      };
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody());

  assert.equal(response.status, 200);
  assert.equal(json.outcome, "refused");
  assert.equal(
    json.reason,
    "nonce must be greater than the tenant high-water mark",
  );
  assert.deepEqual(state.events, [
    "payment",
    "lookup",
    "resolve",
    "reserve",
    "record",
  ]);
  assert.equal(state.verdicts[0]?.outcome, "refused");
});

test("POST /review refuses a pending retry without submitting approval", async () => {
  const state = harness({
    reserveNonce() {
      state.events.push("reserve");
      return { status: "retry", outcome: null };
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody());

  assert.equal(response.status, 200);
  assert.deepEqual(json, {
    outcome: "refused",
    reason: "mandate review is already pending",
    scheduleId: "0.0.7001",
    mandateDigest: digest,
    settlementId: "0.0.8001@1788509000.000000001",
    mirrorNodeUrl:
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/4",
  });
  assert.deepEqual(state.events, [
    "payment",
    "lookup",
    "resolve",
    "reserve",
    "record",
  ]);
  assert.equal(state.verdicts[0]?.outcome, "refused");
});

test("POST /review returns a retryable response for replay-store contention", async () => {
  const state = harness({
    reserveNonce() {
      state.events.push("reserve");
      throw new ReplayStoreContentionError(new Error("database is locked"));
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody());

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(json, {
    error: "replay database is busy; retry the review",
  });
  assert.deepEqual(state.events, ["payment", "lookup", "resolve", "reserve"]);
  assert.deepEqual(state.verdicts, []);
});

test("POST /review replays a completed approval before pending schedule validation", async () => {
  const state = harness({
    lookupCompletedReview() {
      state.events.push("lookup");
      return {
        outcome: "approved",
        recipientAccountId: "0.0.1002",
        amountTinybars: "25000000",
        settlementId: "0.0.8001@1788509000.000000001",
        mirrorNodeUrl:
          "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/4",
      };
    },
    async resolveSchedule() {
      state.events.push("resolve");
      return resolvedSchedule(
        schedule({ executed: { seconds: 1788509001n, nanos: 0n } }),
      );
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody());

  assert.equal(response.status, 200);
  assert.deepEqual(json, {
    outcome: "approved",
    recipientAccountId: "0.0.1002",
    amountTinybars: "25000000",
    scheduleId: "0.0.7001",
    mandateDigest: digest,
    settlementId: "0.0.8001@1788509000.000000001",
    mirrorNodeUrl:
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/4",
  });
  assert.deepEqual(state.events, ["payment", "lookup"]);
  assert.deepEqual(state.verdicts, []);
});

test("POST /review completes the approved orchestration in order", async () => {
  const state = harness();

  const { response, json } = await postReview(state.dependencies, requestBody(), {
    "payment-signature": "paid-request",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("payment-response"), "settled");
  assert.deepEqual(json, {
    outcome: "approved",
    recipientAccountId: "0.0.1002",
    amountTinybars: "25000000",
    scheduleId: "0.0.7001",
    mandateDigest: digest,
    settlementId: "0.0.8001@1788509000.000000001",
    mirrorNodeUrl:
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/4",
  });
  assert.deepEqual(state.events, [
    "payment",
    "lookup",
    "resolve",
    "reserve",
    "submit",
    "record",
    "complete",
  ]);
  assert.equal(state.verdicts[0]?.outcome, "approved");
  assert.deepEqual(state.completions, [
    {
      outcome: "approved",
      recipientAccountId: "0.0.1002",
      amountTinybars: "25000000",
      settlementId: "0.0.8001@1788509000.000000001",
      mirrorNodeUrl:
        "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/4",
    },
  ]);
});

const productionConfig: ProductionReviewServerConfig = {
  ownerPublicKey: ownerKey.publicKey,
  agentPublicKey: agentKey,
  guardPublicKey: guardKey,
  expectedAgentAccountId: "0.0.2001",
  treasuryAccountId: "0.0.1001",
  protocolMaxFeeTinybars: "100000000",
  allowedNetworkVersions: {
    protobuf: "0.64.0",
    services: "0.64.0",
  },
  replayDatabasePath: "var/reviews.sqlite",
  payment: {
    resourceUrl: "https://guard.example/review",
    priceTinybars: "1000000",
    operationalAccount: {
      accountId: "0.0.9001",
      publicKey: operationalKey,
    },
  },
  verdictTopicId: "0.0.9100",
  participantIdentities: {
    agent: {
      registry: "countersign",
      name: "Countersign Agent",
      version: "0.1.0",
      protocol: "hcs-10",
      nativeId: "hedera:testnet:0.0.2001",
      skills: [0],
    },
    guard: {
      registry: "countersign",
      name: "Countersign Guard",
      version: "0.1.0",
      protocol: "hcs-10",
      nativeId: "hedera:testnet:0.0.3001",
      skills: [0],
    },
  },
};

function configuredClient(operatorKey = guardKey): Client {
  return Client.forTestnet().setOperatorWith(
    "0.0.3001",
    operatorKey,
    async () => new Uint8Array(64),
  );
}

function productionServices(
  overrides: Partial<ProductionReviewServerServices> = {},
): ProductionReviewServerServices {
  return {
    async executeAccountInfoQuery(_client, query) {
      const accountId = query.accountId?.toString();
      if (accountId === undefined) {
        throw new Error("account query must contain an AccountID");
      }
      if (accountId === productionConfig.payment.operationalAccount.accountId) {
        return { accountId, key: operationalKey };
      }
      if (accountId === productionConfig.treasuryAccountId) {
        return { accountId, key: treasuryKey };
      }
      if (accountId === productionConfig.expectedAgentAccountId) {
        return { accountId, key: agentKey };
      }
      throw new Error(`unexpected account lookup: ${accountId}`);
    },
    async executeNetworkVersionInfoQuery() {
      return {
        protobufVersion: { major: 0, minor: 64, patch: 0 },
        servicesVersion: { major: 0, minor: 64, patch: 0 },
      };
    },
    async executeScheduleInfoQuery() {
      return schedule();
    },
    async createPaymentGate() {
      return {
        async review() {
          return {
            paid: false,
            status: 402,
            headers: { "payment-required": "challenge" },
            body: { error: "payment required" },
          };
        },
      };
    },
    async openVerdictLog() {
      return {
        async record() {
          return {
            topicId: "0.0.9100",
            sequenceNumber: "1",
            mirrorNodeUrl:
              "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9100/messages/1",
          };
        },
      };
    },
    ...overrides,
  };
}

test("production server requires the client operator to use the guard key", async (t) => {
  for (const [name, client] of [
    ["missing operator", Client.forTestnet()],
    [
      "different operator key",
      configuredClient(PrivateKey.generateED25519().publicKey),
    ],
  ] as const) {
    await t.test(name, async () => {
      let accountLookupCalled = false;

      try {
        await assert.rejects(
          createProductionReviewServer(
            client,
            productionConfig,
            productionServices({
              async executeAccountInfoQuery() {
                accountLookupCalled = true;
                return {
                  accountId: productionConfig.payment.operationalAccount.accountId,
                  key: operationalKey,
                };
              },
            }),
          ),
          /client operator key must equal the configured guard key/,
        );
        assert.equal(accountLookupCalled, false);
      } finally {
        client.close();
      }
    });
  }
});

test("production server requires pairwise-distinct authorization keys", async (t) => {
  for (const [name, config] of [
    [
      "owner and agent",
      { ...productionConfig, agentPublicKey: ownerKey.publicKey },
    ],
    [
      "owner and guard",
      { ...productionConfig, ownerPublicKey: guardKey },
    ],
    [
      "agent and guard",
      { ...productionConfig, guardPublicKey: agentKey },
    ],
  ] as const) {
    await t.test(name, async () => {
      const client = configuredClient(config.guardPublicKey);
      try {
        await assert.rejects(
          createProductionReviewServer(client, config, productionServices()),
          /owner, agent, and guard keys must be pairwise distinct/,
        );
      } finally {
        client.close();
      }
    });
  }
});

test("production server requires the exact nested treasury authorization tree", async (t) => {
  const innerKey = new KeyList([agentKey, guardKey], 2);
  for (const [name, key] of [
    ["single key", ownerKey.publicKey],
    ["outer threshold", new KeyList([ownerKey.publicKey, innerKey], 2)],
    [
      "missing owner branch",
      new KeyList([operationalKey, innerKey], 1),
    ],
    [
      "inner threshold",
      new KeyList(
        [ownerKey.publicKey, new KeyList([agentKey, guardKey], 1)],
        1,
      ),
    ],
    [
      "inner membership",
      new KeyList(
        [ownerKey.publicKey, new KeyList([agentKey, operationalKey], 2)],
        1,
      ),
    ],
    [
      "extra outer branch",
      new KeyList([ownerKey.publicKey, innerKey, operationalKey], 1),
    ],
  ] as const) {
    await t.test(name, async () => {
      const client = configuredClient();
      try {
        await assert.rejects(
          createProductionReviewServer(
            client,
            productionConfig,
            productionServices({
              async executeAccountInfoQuery(client, query) {
                if (
                  query.accountId?.toString() ===
                  productionConfig.treasuryAccountId
                ) {
                  return {
                    accountId: productionConfig.treasuryAccountId,
                    key,
                  };
                }
                return productionServices().executeAccountInfoQuery(
                  client,
                  query,
                );
              },
            }),
          ),
          /treasury account must use the configured nested authorization tree/,
        );
      } finally {
        client.close();
      }
    });
  }
});

test("production server binds the configured agent account to the agent key", async (t) => {
  for (const [name, accountId, key, reason] of [
    [
      "different account",
      "0.0.2002",
      agentKey,
      /returned agent account does not match the configured account/,
    ],
    [
      "different key",
      productionConfig.expectedAgentAccountId,
      operationalKey,
      /agent account key does not match the configured agent key/,
    ],
  ] as const) {
    await t.test(name, async () => {
      const client = configuredClient();
      try {
        await assert.rejects(
          createProductionReviewServer(
            client,
            productionConfig,
            productionServices({
              async executeAccountInfoQuery(client, query) {
                if (
                  query.accountId?.toString() ===
                  productionConfig.expectedAgentAccountId
                ) {
                  return { accountId, key };
                }
                return productionServices().executeAccountInfoQuery(
                  client,
                  query,
                );
              },
            }),
          ),
          reason,
        );
      } finally {
        client.close();
      }
    });
  }
});

test("production server verifies the operational payment account key from consensus", async (t) => {
  for (const [name, key, reason] of [
    ["threshold key", new KeyList([operationalKey]), /single public key/],
    [
      "different public key",
      PrivateKey.generateED25519().publicKey,
      /does not match the configured operational key/,
    ],
  ] as const) {
    await t.test(name, async () => {
      const client = configuredClient();
      try {
        await assert.rejects(
          createProductionReviewServer(
            client,
            productionConfig,
            productionServices({
              async executeAccountInfoQuery(client, query) {
                const accountId = query.accountId?.toString();
                if (
                  accountId ===
                  productionConfig.payment.operationalAccount.accountId
                ) {
                  return { accountId, key };
                }
                return productionServices().executeAccountInfoQuery(
                  client,
                  query,
                );
              },
            }),
          ),
          reason,
        );
      } finally {
        client.close();
      }
    });
  }
});

test("production server verifies the operational payment account ID from consensus", async () => {
  const client = configuredClient();

  try {
    await assert.rejects(
      createProductionReviewServer(
        client,
        productionConfig,
        productionServices({
          async executeAccountInfoQuery(client, query) {
            const accountId = query.accountId?.toString();
            if (
              accountId === productionConfig.payment.operationalAccount.accountId
            ) {
              return { accountId: "0.0.9002", key: operationalKey };
            }
            return productionServices().executeAccountInfoQuery(
              client,
              query,
            );
          },
        }),
      ),
      /does not match the configured account/,
    );
  } finally {
    client.close();
  }
});

test("production server keeps the operational payment account separate", async (t) => {
  for (const [name, accountId, publicKey] of [
    ["authorization key", "0.0.9001", guardKey],
    ["treasury account", "0.0.1001", operationalKey],
    ["agent account", "0.0.2001", operationalKey],
    ["guard account", "0.0.3001", operationalKey],
  ] as const) {
    await t.test(name, async () => {
      const client = configuredClient();
      const config: ProductionReviewServerConfig = {
        ...productionConfig,
        payment: {
          ...productionConfig.payment,
          operationalAccount: { accountId, publicKey },
        },
      };

      try {
        await assert.rejects(
          createProductionReviewServer(
            client,
            config,
            productionServices(),
          ),
          /operational payment identity must be separate from authorization identities/,
        );
      } finally {
        client.close();
      }
    });
  }
});

test("production factory initializes adapters and returns a hostable server with timeouts", async () => {
  const client = configuredClient();
  const events: string[] = [];

  try {
    const server = await createProductionReviewServer(
      client,
      productionConfig,
      productionServices({
        async executeAccountInfoQuery(_client, query) {
          const accountId = query.accountId?.toString();
          if (accountId === undefined) {
            throw new Error("account query must contain an AccountID");
          }
          events.push(`account:${accountId}`);
          return productionServices().executeAccountInfoQuery(_client, query);
        },
        async createPaymentGate(config) {
          events.push(`payment:${config.operationalAccount.accountId}`);
          return productionServices().createPaymentGate(config);
        },
        async openVerdictLog(_client, topicId) {
          events.push(`verdict:${topicId ?? "create"}`);
          return productionServices().openVerdictLog(_client, topicId);
        },
      }),
    );

    assert.equal(server.listening, false);
    assert.equal(server.headersTimeout, 10_000);
    assert.equal(server.requestTimeout, 15_000);
    assert.equal(server.keepAliveTimeout, 5_000);
    assert.equal(server.maxHeadersCount, 50);
    assert.deepEqual(events, [
      "account:0.0.9001",
      "account:0.0.1001",
      "account:0.0.2001",
      "payment:0.0.9001",
      "verdict:0.0.9100",
    ]);
  } finally {
    client.close();
  }
});

test("production schedule resolution pins both version reads and the schedule read to one node", async (t) => {
  for (const [name, versions] of [
    [
      "version before the schedule is outside the audited version",
      [
        { major: 0, minor: 65, patch: 0 },
        { major: 0, minor: 64, patch: 0 },
      ],
    ],
    [
      "version changes after the schedule read",
      [
        { major: 0, minor: 64, patch: 0 },
        { major: 0, minor: 65, patch: 0 },
      ],
    ],
  ] as const) {
    await t.test(name, async () => {
      const databaseDirectory = resolve("var");
      mkdirSync(databaseDirectory, { recursive: true });
      const databasePath = resolve(
        databaseDirectory,
        `server-version-${process.pid}-${Date.now()}.sqlite`,
      );
      const client = configuredClient();
      const reads: string[] = [];
      let versionIndex = 0;
      const server = await createProductionReviewServer(
        client,
        { ...productionConfig, replayDatabasePath: databasePath },
        productionServices({
          async createPaymentGate() {
            return {
              async review() {
                return {
                  paid: true,
                  settlementId: "0.0.8001@1788509000.000000001",
                  responseHeaders: { "payment-response": "settled" },
                };
              },
            };
          },
          async executeNetworkVersionInfoQuery(_client, query) {
            reads.push(
              `version:${query.nodeAccountIds?.map((id) => id.toString()).join(",")}`,
            );
            const version = versions[versionIndex];
            versionIndex += 1;
            if (version === undefined) {
              throw new Error("unexpected extra network-version read");
            }
            return {
              protobufVersion: version,
              servicesVersion: version,
            };
          },
          async executeScheduleInfoQuery(_client, query) {
            reads.push(
              `schedule:${query.scheduleId?.toString()}:${query.nodeAccountIds
                ?.map((id) => id.toString())
                .join(",")}`,
            );
            return schedule();
          },
        }),
      );

      try {
        await new Promise<void>((resolveListen, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolveListen);
        });
        const address = server.address() as AddressInfo;
        const response = await fetch(
          `http://127.0.0.1:${address.port}/review`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(requestBody()),
          },
        );
        const body = (await response.json()) as Record<string, unknown>;

        assert.equal(response.status, 200);
        assert.equal(body.outcome, "refused");
        assert.match(String(body.reason), /network version/);
        assert.deepEqual(reads, [
          "version:0.0.3",
          "schedule:0.0.7001:0.0.3",
          "version:0.0.3",
        ]);
      } finally {
        await new Promise<void>((resolveClose, reject) => {
          server.close((error) =>
            error == null ? resolveClose() : reject(error),
          );
        });
        client.close();
        rmSync(databasePath, { force: true });
      }
    });
  }
});

test("production server generates participant identifiers from HCS-14 identities", async () => {
  const client = configuredClient();

  try {
    await assert.rejects(
      createProductionReviewServer(
        client,
        {
          ...productionConfig,
          participantIdentities: {
            ...productionConfig.participantIdentities,
            agent: {
              ...productionConfig.participantIdentities.agent,
              nativeId: "not-a-hedera-account",
            },
          },
        },
        productionServices(),
      ),
      /nativeId must be a Hedera CAIP-10 account identifier for hcs-10/,
    );
  } finally {
    client.close();
  }
});
