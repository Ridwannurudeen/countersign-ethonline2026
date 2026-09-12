import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { proto } from "@hiero-ledger/proto";
import { AccountId, Client, Hbar, KeyList, PrivateKey, PublicKey, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";

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
  completeMandateReview,
  getCompletedMandateReview,
  initializeReplayStore,
  getMandateReviewState,
  ReplayStoreContentionError,
  reserveMandateReview,
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
import { countersignTransfer } from "../src/countersign-transfer.ts";
import { createPaymentGate } from "../src/payment-gate.ts";
import { openVerdictLog } from "../src/verdict-log.ts";
import { generateHcs14Aid } from "../src/hcs14.ts";

const ownerKey = PrivateKey.generateED25519();
const agentPrivateKey = PrivateKey.generateED25519();
const agentKey = agentPrivateKey.publicKey;
const guardPrivateKey = PrivateKey.generateED25519();
const guardKey = guardPrivateKey.publicKey;
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
    countersign: {
      protocolMaxFeeTinybars: "100000000",
      nowEpochSeconds: () => "1788509005",
      sign: (approval) => countersignTransfer(approval, guardPrivateKey),
    },
    tenants: new Map([[mandate.tenantId, {
      ownerPublicKey: ownerKey.publicKey,
      agentPublicKey: agentKey,
      expectedAgentAccountId: "0.0.2001",
      treasuryAccountId: "0.0.1001",
      agentIdentifier: "uaid:aid:agent;nativeId=hedera:testnet:0.0.2001",
    }]]),
    guardPublicKey: guardKey,
    payment: { resourceUrl: "https://guard.example/review", priceTinybars: "1000000" },
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
    lookupReviewState() {
      return { status: "absent" };
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
  path = "/review",
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const server = createReviewServer(dependencies);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
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

test("INVARIANT: a mandate issued for one tenant must never authorize a schedule bound to another tenant", async () => {
  const state = harness();
  const outOfPolicyMandate = {
    ...mandate,
    tenantId: "treasury-2",
  };
  const { response, json } = await postReview(state.dependencies, {
    tenantId: outOfPolicyMandate.tenantId,
    mandateEnvelope: signedMandateEnvelope(outOfPolicyMandate),
    scheduleId: "0.0.7001",
  });

  assert.equal(response.status, 403);
  assert.match(String(json.error), /mandate tenant is not authorized/);
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

test("POST /review keeps a pending retry retryable without publishing a refusal", async () => {
  const state = harness({
    reserveNonce() {
      state.events.push("reserve");
      return { status: "retry", outcome: null };
    },
  });

  const { response, json } = await postReview(state.dependencies, requestBody());

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(json, { error: "mandate review is already pending" });
  assert.deepEqual(state.events, [
    "payment",
    "lookup",
    "resolve",
    "reserve",
    "resolve",
  ]);
  assert.deepEqual(state.verdicts, []);
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
  signCountersign: (approval) => countersignTransfer(approval, guardPrivateKey),
  tenants: new Map([[mandate.tenantId, {
    ownerPublicKey: ownerKey.publicKey,
    agentPublicKey: agentKey,
    expectedAgentAccountId: "0.0.2001",
    treasuryAccountId: "0.0.1001",
    agentIdentity: {
      registry: "countersign",
      name: "Countersign Agent",
      version: "0.1.0",
      protocol: "hcs-10",
      nativeId: "hedera:testnet:0.0.2001",
      skills: [0],
    },
  }]]),
  guardPublicKey: guardKey,
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
  guardIdentity: {
      registry: "countersign",
      name: "Countersign Guard",
      version: "0.1.0",
      protocol: "hcs-10",
      nativeId: "hedera:testnet:0.0.3001",
      skills: [0],
  },
};

const productionTenant = productionConfig.tenants.get(mandate.tenantId)!;

test("INVARIANT: tenant owner and agent private key material must never enter server configuration or persisted state", () => {
  const databaseDirectory = resolve("var");
  mkdirSync(databaseDirectory, { recursive: true });
  const databasePath = resolve(
    databaseDirectory,
    `server-key-material-${process.pid}-${Date.now()}.sqlite`,
  );
  const config: ProductionReviewServerConfig = {
    ...productionConfig,
    replayDatabasePath: databasePath,
  };

  try {
    initializeReplayStore(databasePath);
    reserveMandateReview(databasePath, {
      tenantId: mandate.tenantId,
      nonce: mandate.nonce,
      mandateDigest: digest,
      scheduleId: "0.0.7001",
    });

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = database
        .prepare("SELECT name FROM pragma_table_info('mandate_reviews')")
        .all()
        .map((row) => String(row.name));
      const rows = database.prepare("SELECT * FROM mandate_reviews").all();
      const serializedConfig = JSON.stringify(config);
      const serializedRows = JSON.stringify(rows);

      assert.deepEqual(
        Object.keys(config).filter((field) => /private/i.test(field)),
        [],
      );
      assert.equal(config.tenants.get(mandate.tenantId)!.ownerPublicKey instanceof PrivateKey, false);
      assert.equal(config.tenants.get(mandate.tenantId)!.agentPublicKey instanceof PrivateKey, false);
      assert.deepEqual(
        columns.filter((column) => /(owner|agent|private).*key/i.test(column)),
        [],
      );
      for (const privateKey of [ownerKey, agentPrivateKey]) {
        const privateMaterial = privateKey.toStringDer();
        assert.equal(serializedConfig.includes(privateMaterial), false);
        assert.equal(serializedRows.includes(privateMaterial), false);
      }
    } finally {
      database.close();
    }
  } finally {
    rmSync(databasePath, { force: true });
  }
});

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
      if (accountId === productionTenant.treasuryAccountId) {
        return { accountId, key: treasuryKey };
      }
      if (accountId === productionTenant.expectedAgentAccountId) {
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
      { ...productionConfig, tenants: new Map([[mandate.tenantId, { ...productionTenant, agentPublicKey: ownerKey.publicKey }]]) },
    ],
    [
      "owner and guard",
      { ...productionConfig, tenants: new Map([[mandate.tenantId, { ...productionTenant, ownerPublicKey: guardKey }]]) },
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
                  productionTenant.treasuryAccountId
                ) {
                  return {
                    accountId: productionTenant.treasuryAccountId,
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

test("INVARIANT: startup refuses a second tenant whose treasury key tree does not contain the guard key and names that tenant", async () => {
  const client = configuredClient();
  const databasePath = resolve("var", `second-tenant-${process.pid}.sqlite`);
  const secondTenant = {
    ...productionTenant,
    treasuryAccountId: "0.0.1003",
    expectedAgentAccountId: "0.0.2003",
    agentIdentity: {
      ...productionTenant.agentIdentity,
      nativeId: "hedera:testnet:0.0.2003",
    },
  };
  const accounts: string[] = [];
  let server: ReturnType<typeof createReviewServer> | undefined;
  try {
    await assert.rejects(async () => {
      server = await createProductionReviewServer(client, {
        ...productionConfig,
        replayDatabasePath: databasePath,
        tenants: new Map([
          [mandate.tenantId, productionTenant],
          ["treasury-2", secondTenant],
        ]),
      }, productionServices({
        async executeAccountInfoQuery(client, query) {
          const accountId = query.accountId!.toString();
          accounts.push(accountId);
          if (accountId === secondTenant.treasuryAccountId) {
            return {
              accountId,
              key: new KeyList([
                ownerKey.publicKey,
                new KeyList([agentKey, operationalKey], 2),
              ], 1),
            };
          }
          if (accountId === secondTenant.expectedAgentAccountId) {
            return { accountId, key: agentKey };
          }
          return productionServices().executeAccountInfoQuery(client, query);
        },
      }));
    }, /^Error: tenant treasury-2: treasury account must use the configured nested authorization tree$/);
    assert.ok(accounts.includes(productionTenant.treasuryAccountId));
    assert.ok(accounts.includes(secondTenant.treasuryAccountId));
  } finally {
    server?.close();
    client.close();
    rmSync(databasePath, { force: true });
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
      productionTenant.expectedAgentAccountId,
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
                  productionTenant.expectedAgentAccountId
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
          tenants: new Map([[mandate.tenantId, {
            ...productionTenant,
            agentIdentity: { ...productionTenant.agentIdentity, nativeId: "not-a-hedera-account" },
          }]]),
        },
        productionServices(),
      ),
      /nativeId must be a Hedera CAIP-10 account identifier for hcs-10/,
    );
  } finally {
    client.close();
  }
});

async function getGuard(
  dependencies: ReviewServerDependencies,
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const server = createReviewServer(dependencies);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/guard`);
    const json = (await response.json()) as Record<string, unknown>;
    return { response, json };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error == null ? resolve() : reject(error)));
    });
  }
}

test("GET /guard returns the guard public key and HCS-14 identifier", async () => {
  const state = harness();
  const { response, json } = await getGuard(state.dependencies);

  assert.equal(response.status, 200);
  assert.equal(json.guardPublicKey, guardKey.toString());
  assert.equal(
    json.guardIdentifier,
    state.dependencies.participantIdentifiers.guard,
  );
  assert.equal(
    PublicKey.fromString(String(json.guardPublicKey)).equals(guardKey),
    true,
  );
});

test("INVARIANT: the public guard identity response never contains private key material or tenant data", async () => {
  const state = harness();
  const { json } = await getGuard(state.dependencies);
  const serialized = JSON.stringify(json);

  assert.deepEqual(Object.keys(json).sort(), [
    "guardIdentifier",
    "guardPublicKey",
  ]);
  assert.equal(serialized.includes(guardPrivateKey.toStringRaw()), false);
  assert.equal(serialized.includes(mandate.tenantId), false);
});

test("GET /guard succeeds without a payment header", async () => {
  const state = harness();
  const { response } = await getGuard(state.dependencies);

  assert.equal(response.status, 200);
  assert.deepEqual(state.events, []);
});

test("GET /.well-known/agent.json publishes the configured public review endpoint and payment terms without tenant data or payment", async () => {
  const client = configuredClient();
  const databasePath = resolve("var", `agent-card-${process.pid}.sqlite`);
  let paymentCalls = 0;
  const config = {
    ...productionConfig,
    replayDatabasePath: databasePath,
    payment: { ...productionConfig.payment, resourceUrl: "https://public-guard.example:8443/review", priceTinybars: "2000000" },
  };
  const server = await createProductionReviewServer(client, config, productionServices({
    async createPaymentGate() {
      return { async review() { paymentCalls += 1; throw new Error("card must be unpaid"); } };
    },
  }));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/agent.json`);
    assert.equal(response.status, 200);
    const card = await response.json();
    assert.deepEqual(card, {
      name: "Countersign Guard",
      description: "Paid authorization review of Hedera schedules against owner-signed policy mandates.",
      uaid: generateHcs14Aid(config.guardIdentity),
      guardPublicKey: guardKey.toString(),
      url: config.payment.resourceUrl,
      service: [
        { id: "review", type: "HTTP", serviceEndpoint: config.payment.resourceUrl, method: "POST" },
        { id: "countersign", type: "HTTP", serviceEndpoint: "https://public-guard.example:8443/countersign", method: "POST" },
      ],
      capabilities: {
        extensions: [{
          uri: "https://www.x402.org/",
          description: "x402 payment required for each authorization review; settled through Blocky402.",
          required: true,
          params: { network: "hedera:testnet", asset: "0.0.0", priceTinybars: "2000000" },
        }],
      },
      tenantCount: 1,
    });
    const serialized = JSON.stringify(card);
    for (const value of [mandate.tenantId, productionTenant.treasuryAccountId, productionTenant.expectedAgentAccountId, ownerKey.publicKey.toString(), guardPrivateKey.toStringRaw(), "127.0.0.1"]) {
      assert.equal(serialized.includes(value), false);
    }
    assert.equal(paymentCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    client.close();
    rmSync(databasePath, { force: true });
  }
});

async function countersignHarness(t: TestContext) {
  const directory = mkdtempSync(resolve("var", "countersign-http-"));
  const databasePath = resolve(directory, "replay.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  initializeReplayStore(databasePath);
  const state = harness();
  state.dependencies.tenants.get(mandate.tenantId)!.agentIdentifier = generateHcs14Aid(productionTenant.agentIdentity);
  state.dependencies.participantIdentifiers.guard = generateHcs14Aid(productionConfig.guardIdentity);
  const transaction = await new TransferTransaction()
    .setTransactionId(TransactionId.fromString("0.0.4001@1788509000.000000000"))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .setMaxTransactionFee(Hbar.fromTinybars("100000000"))
    .addHbarTransfer("0.0.1001", Hbar.fromTinybars(-100))
    .addHbarTransfer("0.0.1002", Hbar.fromTinybars(100))
    .freeze().sign(agentPrivateKey);
  const transactionBase64 = Buffer.from(transaction.toBytes()).toString("base64");
  const transactionDigest = createHash("sha256").update(transaction.toBytes()).digest("hex");
  const reservation = { tenantId: mandate.tenantId, nonce: mandate.nonce, mandateDigest: digest, transactionDigest };
  const messages: Record<string, unknown>[] = [];
  state.dependencies.reserveNonce = (value) => {
    state.events.push("reserve");
    return reserveMandateReview(databasePath, value);
  };
  state.dependencies.lookupCompletedReview = (value) => getCompletedMandateReview(databasePath, value);
  state.dependencies.lookupReviewState = (value) => getMandateReviewState(databasePath, value);
  state.dependencies.completeNonce = (value, completion) => completeMandateReview(databasePath, value, completion);
  const originalSign = guardPrivateKey.sign.bind(guardPrivateKey);
  t.mock.method(guardPrivateKey, "sign", (bytes: Uint8Array) => {
    state.events.push("guard-sign");
    assert.equal(getMandateReviewState(databasePath, reservation).status, "pending", "nonce must be durably reserved before guard signing");
    return originalSign(bytes);
  });
  state.dependencies.verdictLog = await openVerdictLog({
    async lookupTopic() {},
    async createTopic() { return "0.0.9001"; },
    async submitMessage(_topicId, message) {
      state.events.push("record");
      messages.push(JSON.parse(message) as Record<string, unknown>);
      return messages.length.toString();
    },
  });
  state.dependencies.paymentGate = await createPaymentGate({
    ...productionConfig.payment,
    treasuryAuthorizations: [{
      accountId: mandate.treasuryAccountId,
      ownerPublicKey: ownerKey.publicKey,
      agentPublicKey: agentKey,
      guardPublicKey: guardKey,
    }],
  }, {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.7162784" } }],
        extensions: [], signers: { "hedera:*": ["0.0.7162784"] },
      };
    },
    async verify() { state.events.push("verify-payment"); return { isValid: true, payer: "0.0.8001" }; },
    async settle() {
      state.events.push("settle-payment");
      return { success: true, payer: "0.0.8001", transaction: "0.0.8001@1788509000.000000001", network: "hedera:testnet" };
    },
  });
  const challenge = await state.dependencies.paymentGate.review(undefined, "/countersign");
  assert.ok(!challenge.paid);
  const required = decodePaymentRequiredHeader(challenge.headers["PAYMENT-REQUIRED"]);
  assert.equal(required.resource?.url, "https://guard.example/countersign");
  const payer = PrivateKey.generateED25519();
  const paymentTransaction = await new TransferTransaction()
    .setTransactionId(TransactionId.fromString("0.0.8001@1788509000.000000001"))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .addHbarTransfer("0.0.8001", Hbar.fromTinybars(-1000000))
    .addHbarTransfer("0.0.9001", Hbar.fromTinybars(1000000))
    .freeze().sign(payer);
  const headers = { "payment-signature": encodePaymentSignatureHeader({
    x402Version: 2, resource: required.resource, accepted: required.accepts[0],
    payload: { transaction: Buffer.from(paymentTransaction.toBytes()).toString("base64") },
  }) };
  const body = { tenantId: mandate.tenantId, mandateEnvelope: signedMandateEnvelope(), transactionBase64 };
  return { ...state, body, headers, messages, databasePath, reservation };
}

test("POST /countersign challenges unpaid requests before authorization, reservation or signing", async (t) => {
  const state = await countersignHarness(t);
  state.dependencies.reviewObserver = { onReviewCheck() { assert.fail("unpaid authorization"); } };
  const { response, json } = await postReview(state.dependencies, state.body, {}, "/countersign");
  assert.equal(response.status, 402);
  assert.ok(response.headers.get("payment-required"));
  assert.equal(json.transactionBase64, undefined);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.messages, []);
});

test("POST /countersign settles, reserves before the real guard signature, and records the reviewed transfer", async (t) => {
  const state = await countersignHarness(t);
  const { response, json } = await postReview(state.dependencies, state.body, state.headers, "/countersign");
  assert.equal(response.status, 200);
  assert.equal(json.outcome, "approved");
  assert.ok(response.headers.get("payment-response"));
  assert.deepEqual(state.events, ["settle-payment", "reserve", "guard-sign", "record"]);
  assert.equal(json.transactionId, "0.0.4001@1788509000.000000000");
  assert.equal(json.transactionDigest, state.reservation.transactionDigest);
  assert.equal(json.mandateDigest, digest);
  assert.equal(json.mirrorNodeUrl, "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/1");
  assert.deepEqual(state.messages[0], {
    v: 1, outcome: "approved", transactionId: json.transactionId,
    transactionDigest: json.transactionDigest, mandateDigest: digest,
    settlementId: json.settlementId, tenantId: mandate.tenantId,
    participants: { agent: state.dependencies.tenants.get(mandate.tenantId)!.agentIdentifier, guard: state.dependencies.participantIdentifiers.guard },
  });
  const original = proto.TransactionList.decode(Buffer.from(state.body.transactionBase64, "base64"));
  const signed = proto.TransactionList.decode(Buffer.from(json.transactionBase64 as string, "base64"));
  const before = proto.SignedTransaction.decode(original.transactionList[0].signedTransactionBytes!);
  const after = proto.SignedTransaction.decode(signed.transactionList[0].signedTransactionBytes!);
  assert.deepEqual(after.bodyBytes, before.bodyBytes);
  assert.deepEqual(after.sigMap!.sigPair![0], before.sigMap!.sigPair![0]);
  assert.equal(after.sigMap!.sigPair!.length, 2);
  assert.ok(guardKey.verify(after.bodyBytes, after.sigMap!.sigPair![1].ed25519!));
});

for (const refusal of ["cap", "owner signature", "malformed bytes"] as const) {
  test(`POST /countersign delivers a paid ${refusal} refusal with independent HCS evidence`, async (t) => {
    const state = await countersignHarness(t);
    const body = { ...state.body };
    const invariant = refusal === "cap" ? "transfer amount is within the mandate cap"
      : refusal === "owner signature" ? "mandate signature is valid for the configured owner"
      : "transaction bytes are canonical nonempty base64";
    if (refusal === "cap") body.mandateEnvelope = signedMandateEnvelope({ ...mandate, maxAmountTinybars: "1" });
    if (refusal === "owner signature") body.mandateEnvelope = { ...body.mandateEnvelope, signature: Buffer.alloc(64).toString("base64url") };
    if (refusal === "malformed bytes") body.transactionBase64 = "!";
    const { response, json } = await postReview(state.dependencies, body, state.headers, "/countersign");
    assert.equal(response.status, 200);
    assert.equal(json.outcome, "refused");
    assert.equal(json.invariant, invariant);
    assert.equal(json.transactionBase64, undefined);
    assert.ok(response.headers.get("payment-response"));
    assert.deepEqual(state.events, ["settle-payment", "record"]);
    assert.equal(state.messages[0].invariant, invariant);
    assert.equal(state.messages[0].transactionId, refusal === "malformed bytes" ? null : "0.0.4001@1788509000.000000000");
    assert.equal(state.messages[0].transactionDigest, createHash("sha256").update(Buffer.from(body.transactionBase64, "base64")).digest("hex"));
    assert.equal(state.messages[0].mandateDigest, mandateDigest(body.mandateEnvelope.mandate));
    assert.equal(state.messages[0].settlementId, json.settlementId);
    assert.equal(getMandateReviewState(state.databasePath, state.reservation).status, "absent");
  });
}

test("POST /countersign refuses unknown tenants without disclosing enrollment", async (t) => {
  const state = await countersignHarness(t);
  for (const tenantId of ["unknown-a", "unknown-b"]) {
    const { response, json } = await postReview(state.dependencies, {
      ...state.body, tenantId, mandateEnvelope: signedMandateEnvelope({ ...mandate, tenantId }),
    }, state.headers, "/countersign");
    assert.equal(response.status, 403);
    assert.deepEqual(json, { error: "mandate tenant is not authorized" });
  }
  assert.deepEqual(state.events, []);
});

test("POST /countersign rejects request shape and tenant binding errors before payment", async (t) => {
  const state = await countersignHarness(t);
  for (const body of [
    { ...state.body, tenantId: "other" },
    { ...state.body, scheduleId: "0.0.7001" },
    { ...state.body, transactionBase64: 42 },
    { tenantId: mandate.tenantId, mandateEnvelope: state.body.mandateEnvelope },
  ]) {
    const { response } = await postReview(state.dependencies, body, state.headers, "/countersign");
    assert.equal(response.status, 400);
  }
  assert.deepEqual(state.events, []);
});

test("POST /countersign shares nonce exclusion with the schedule path in both directions", async (t) => {
  const state = await countersignHarness(t);
  const scheduled = { tenantId: mandate.tenantId, nonce: mandate.nonce, mandateDigest: digest, scheduleId: "0.0.7001" };
  assert.equal(reserveMandateReview(state.databasePath, scheduled).status, "reserved");
  const { response, json } = await postReview(state.dependencies, state.body, state.headers, "/countersign");
  assert.equal(response.status, 200);
  assert.equal(json.outcome, "refused");
  assert.equal(state.events.includes("guard-sign"), false);
  assert.equal(state.messages[0].invariant, json.invariant);
  const next = { ...state.reservation, nonce: "8" };
  assert.equal(reserveMandateReview(state.databasePath, next).status, "reserved");
  assert.equal(reserveMandateReview(state.databasePath, { ...scheduled, nonce: "8" }).status, "refused");
});

test("POST /countersign concurrent paid requests produce only one guard signature", async (t) => {
  const state = await countersignHarness(t);
  const results = await Promise.all([
    postReview(state.dependencies, state.body, state.headers, "/countersign"),
    postReview(state.dependencies, state.body, state.headers, "/countersign"),
  ]);
  assert.ok(results.some(({ json }) => json.outcome === "approved"));
  for (const { response, json } of results) {
    assert.ok(json.outcome === "approved" || (response.status === 503 && json.outcome === undefined));
  }
  assert.equal(state.events.filter((event) => event === "guard-sign").length, 1);
  assert.equal(state.messages.length, 1);
  assert.equal(state.events.filter((event) => event === "settle-payment").length, 2);
});

test("POST /countersign reservation failure cannot produce a guard signature", async (t) => {
  const state = await countersignHarness(t);
  state.dependencies.reserveNonce = () => { throw new Error("storage unavailable"); };
  const { response, json } = await postReview(state.dependencies, state.body, state.headers, "/countersign");
  assert.equal(response.status, 500);
  assert.equal(json.transactionBase64, undefined);
  assert.equal(state.events.includes("guard-sign"), false);
  assert.deepEqual(state.messages, []);
});

test("POST /countersign HCS failure withholds signed bytes and keeps the nonce reserved", async (t) => {
  const state = await countersignHarness(t);
  state.dependencies.verdictLog = { async record() { throw new Error("HCS unavailable"); } };
  const { response, json } = await postReview(state.dependencies, state.body, state.headers, "/countersign");
  assert.equal(response.status, 500);
  assert.equal(json.transactionBase64, undefined);
  assert.ok(response.headers.get("payment-response"));
  assert.equal(getMandateReviewState(state.databasePath, state.reservation).status, "pending");
});

test("POST /countersign logs a paid refusal even when the decoded transaction ID has invalid validity fields", async (t) => {
  const state = await countersignHarness(t);
  const list = proto.TransactionList.decode(Buffer.from(state.body.transactionBase64, "base64"));
  const signed = proto.SignedTransaction.decode(list.transactionList[0].signedTransactionBytes!);
  const body = proto.TransactionBody.decode(signed.bodyBytes);
  body.transactionID!.transactionValidStart!.nanos = -1;
  signed.bodyBytes = proto.TransactionBody.encode(body).finish();
  signed.sigMap = { sigPair: [agentKey._toProtobufSignature(agentPrivateKey.sign(signed.bodyBytes))] };
  list.transactionList[0].signedTransactionBytes = proto.SignedTransaction.encode(signed).finish();
  const transactionBase64 = Buffer.from(proto.TransactionList.encode(list).finish()).toString("base64");
  const { response, json } = await postReview(state.dependencies, { ...state.body, transactionBase64 }, state.headers, "/countersign");
  assert.equal(response.status, 200);
  assert.equal(json.outcome, "refused");
  assert.equal(json.invariant, "transaction validity fields are present and valid");
  assert.equal(state.messages[0].transactionId, json.transactionId);
  assert.equal(state.messages[0].invariant, json.invariant);
  assert.equal(state.events.includes("guard-sign"), false);
});

test("INVARIANT: countersign retries replay the persisted signature even after validity expires", async (t) => {
  const state = await countersignHarness(t);
  const first = await postReview(state.dependencies, state.body, state.headers, "/countersign");
  assert.equal(first.json.outcome, "approved");
  const retry = await postReview(state.dependencies, state.body, state.headers, "/countersign");
  assert.equal(retry.response.status, 200);
  assert.deepEqual(retry.json, first.json);
  state.dependencies.countersign.nowEpochSeconds = () => mandate.expiresAtEpochSeconds;
  const expired = await postReview(state.dependencies, state.body, state.headers, "/countersign");
  assert.deepEqual(expired.json, first.json);
  assert.equal(getMandateReviewState(state.databasePath, state.reservation).status, "completed");
  assert.equal(state.events.filter((event) => event === "guard-sign").length, 1);
  assert.deepEqual(state.messages.map((message) => message.outcome), ["approved"]);
});

test("INVARIANT: a completed countersign tuple still requires the owner's mandate signature", async (t) => {
  const state = await countersignHarness(t);
  await postReview(state.dependencies, state.body, state.headers, "/countersign");
  const body = {
    ...state.body,
    mandateEnvelope: { ...state.body.mandateEnvelope, signature: Buffer.alloc(64).toString("base64url") },
  };
  const retry = await postReview(state.dependencies, body, state.headers, "/countersign");
  assert.equal(retry.response.status, 401);
  assert.equal(retry.json.transactionBase64, undefined);
  assert.deepEqual(state.messages.map((message) => message.outcome), ["approved"]);
});

test("INVARIANT: an in-flight countersign retry publishes nothing while approval recording is pending", async (t) => {
  const state = await countersignHarness(t);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const record = state.dependencies.verdictLog.record.bind(state.dependencies.verdictLog);
  state.dependencies.verdictLog.record = async (value) => {
    if (value.outcome === "approved") {
      started.resolve();
      await finish.promise;
    }
    return record(value);
  };
  const first = postReview(state.dependencies, state.body, state.headers, "/countersign");
  await started.promise;
  try {
    const retry = await postReview(state.dependencies, state.body, state.headers, "/countersign");
    assert.equal(retry.response.status, 503);
    assert.equal(retry.response.headers.get("retry-after"), "1");
    assert.equal(retry.json.outcome, undefined);
    assert.equal(state.messages.length, 0);
  } finally {
    finish.resolve();
    await first;
  }
  assert.deepEqual(state.messages.map((message) => message.outcome), ["approved"]);
});

test("INVARIANT: countersign still refuses a different transaction under a completed nonce", async (t) => {
  const state = await countersignHarness(t);
  await postReview(state.dependencies, state.body, state.headers, "/countersign");
  const transaction = await new TransferTransaction()
    .setTransactionId(TransactionId.fromString("0.0.4001@1788509001.000000000"))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .setMaxTransactionFee(Hbar.fromTinybars("100000000"))
    .addHbarTransfer("0.0.1001", Hbar.fromTinybars(-100))
    .addHbarTransfer("0.0.1002", Hbar.fromTinybars(100))
    .freeze().sign(agentPrivateKey);
  const body = { ...state.body, transactionBase64: Buffer.from(transaction.toBytes()).toString("base64") };
  const retry = await postReview(state.dependencies, body, state.headers, "/countersign");
  assert.equal(retry.json.outcome, "refused");
  assert.notEqual(retry.json.transactionDigest, state.reservation.transactionDigest);
  assert.equal(state.events.filter((event) => event === "guard-sign").length, 1);
  assert.deepEqual(state.messages.map((message) => message.outcome), ["approved", "refused"]);
});

for (const failure of ["HCS", "completion"] as const) {
  test(`INVARIANT: countersign ${failure} failure cannot turn a signed tuple into refusal evidence`, async (t) => {
    const state = await countersignHarness(t);
    if (failure === "HCS") {
      t.mock.method(state.dependencies.verdictLog, "record", async () => { throw new Error("HCS unavailable"); });
    } else {
      t.mock.method(state.dependencies, "completeNonce", () => { throw new Error("storage unavailable"); });
    }
    const first = await postReview(state.dependencies, state.body, state.headers, "/countersign");
    assert.equal(first.response.status, 500);
    t.mock.restoreAll();
    state.dependencies.countersign.nowEpochSeconds = () => mandate.expiresAtEpochSeconds;
    const retry = await postReview(state.dependencies, state.body, state.headers, "/countersign");
    assert.equal(retry.response.status, 503);
    assert.equal(retry.response.headers.get("retry-after"), "1");
    assert.equal(retry.json.outcome, undefined);
    assert.equal(state.messages.some((message) => message.outcome === "refused"), false);
  });
}

for (const failure of ["receipt", "HCS", "completion"] as const) {
  test(`INVARIANT: review ${failure} failure after consensus signing cannot publish a refusal on retry`, async (t) => {
    const state = await countersignHarness(t);
    let signed = false;
    state.dependencies.resolveSchedule = async () => resolvedSchedule(schedule(signed ? {
      signers: new KeyList([agentKey, guardKey]),
      executed: { seconds: 1788509001n, nanos: 0n },
    } : {}));
    state.dependencies.submitScheduleApproval = async () => {
      signed = true;
      if (failure === "receipt") throw new Error("receipt unavailable");
    };
    if (failure === "HCS") {
      t.mock.method(state.dependencies.verdictLog, "record", async () => { throw new Error("HCS unavailable"); });
    } else if (failure === "completion") {
      t.mock.method(state.dependencies, "completeNonce", () => { throw new Error("storage unavailable"); });
    }
    const first = await postReview(state.dependencies, requestBody(), state.headers);
    assert.equal(first.response.status, 500);
    assert.equal(signed, true);
    t.mock.restoreAll();
    const retry = await postReview(state.dependencies, requestBody(), state.headers);
    assert.equal(retry.response.status, 503);
    assert.equal(retry.response.headers.get("retry-after"), "1");
    assert.equal(retry.json.outcome, undefined);
    assert.equal(state.messages.some((message) => message.outcome === "refused"), false);
  });
}

test("INVARIANT: review re-resolves consensus when a pending reservation races with signing", async () => {
  const state = harness();
  let resolutions = 0;
  state.dependencies.resolveSchedule = async () => {
    resolutions += 1;
    return resolvedSchedule(schedule(resolutions === 1 ? {} : { signers: new KeyList([agentKey, guardKey]) }));
  };
  state.dependencies.reserveNonce = () => ({ status: "retry", outcome: null });
  const retry = await postReview(state.dependencies, requestBody());
  assert.equal(retry.response.status, 503);
  assert.equal(retry.response.headers.get("retry-after"), "1");
  assert.equal(resolutions, 2);
  assert.deepEqual(state.verdicts, []);
});
