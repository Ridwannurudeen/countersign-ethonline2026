import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { proto } from "@hiero-ledger/proto";
import { Client, KeyList, PrivateKey } from "@hiero-ledger/sdk";

import {
  canonicalMandateBytes,
  mandateDigest,
  type Mandate,
} from "../src/mandate.ts";
import type { ReviewableScheduleInfo } from "../src/review-schedule.ts";
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
}

function harness(
  overrides: Partial<ReviewServerDependencies> = {},
): Harness {
  const events: string[] = [];
  const verdicts: VerdictRecord[] = [];
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
    reserveNonce() {
      events.push("reserve");
      return { status: "reserved" };
    },
    async submitScheduleApproval() {
      events.push("submit");
    },
    completeNonce() {
      events.push("complete");
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

  return { dependencies, events, verdicts };
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
  assert.deepEqual(state.events, ["payment", "resolve"]);
});

test("POST /review records a paid authorization refusal without reserving", async () => {
  const state = harness({
    async resolveSchedule() {
      state.events.push("resolve");
      return resolvedSchedule(schedule({ scheduleMemo: "different" }));
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody(), {
    "payment-signature": "paid-request",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("payment-response"), "settled");
  assert.deepEqual(json, {
    outcome: "refused",
    reason: "schedule memo is not bound to the mandate digest",
    scheduleId: "0.0.7001",
    mandateDigest: digest,
    settlementId: "0.0.8001@1788509000.000000001",
    mirrorNodeUrl:
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/4",
  });
  assert.deepEqual(state.events, ["payment", "resolve", "record"]);
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
  assert.deepEqual(state.events, ["payment", "resolve", "reserve", "record"]);
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
  assert.deepEqual(state.events, ["payment", "resolve", "reserve", "record"]);
  assert.equal(state.verdicts[0]?.outcome, "refused");
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
    "resolve",
    "reserve",
    "submit",
    "complete",
    "record",
  ]);
  assert.equal(state.verdicts[0]?.outcome, "approved");
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
    async loadOperationalAccount() {
      return {
        accountId: productionConfig.payment.operationalAccount.accountId,
        key: operationalKey,
      };
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
              async loadOperationalAccount() {
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
              async loadOperationalAccount() {
                return {
                  accountId: productionConfig.payment.operationalAccount.accountId,
                  key,
                };
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
          async loadOperationalAccount() {
            return { accountId: "0.0.9002", key: operationalKey };
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
            productionServices({
              async loadOperationalAccount() {
                return { accountId, key: publicKey };
              },
            }),
          ),
          /operational payment key must be separate from authorization keys/,
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
        async loadOperationalAccount(_client, accountId) {
          events.push(`account:${accountId}`);
          return { accountId, key: operationalKey };
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
      "payment:0.0.9001",
      "verdict:0.0.9100",
    ]);
  } finally {
    client.close();
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
