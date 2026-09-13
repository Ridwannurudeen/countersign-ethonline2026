import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { proto } from "@hiero-ledger/proto";
import { AccountId, KeyList, PrivateKey, ScheduleId, Timestamp, Transaction } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentResponseHeader, x402HTTPClient } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { createClientHederaSigner, inspectHederaTransaction } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import { createA2aServer, A2A_X402_EXTENSION, type A2aTask } from "../src/a2a.ts";
import { countersignTransfer } from "../src/countersign-transfer.ts";
import { canonicalMandateBytes, mandateDigest, type Mandate } from "../src/mandate.ts";
import { createPaymentGate } from "../src/payment-gate.ts";
import {
  completeMandateReview, getCompletedMandateReview, getMandateReviewState,
  initializeReplayStore, reserveMandateReview,
} from "../src/replay-store.ts";
import { createReviewServer, type ReviewServerDependencies } from "../src/server.ts";
import { settleA2aReview } from "../scripts/a2a-client.ts";

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done, reject) => {
    server.close((error) => error == null ? done() : reject(error));
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function harness(t: TestContext, recipient = "0.0.1002") {
  const directory = mkdtempSync(resolve("var", "a2a-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = resolve(directory, "replay.sqlite");
  initializeReplayStore(databasePath);
  const owner = PrivateKey.generateED25519();
  const agent = PrivateKey.generateED25519();
  const guard = PrivateKey.generateED25519();
  const payer = PrivateKey.generateED25519();
  const events: string[] = [];
  const mandate: Mandate = {
    tenantId: "treasury-1", nonce: "7", treasuryAccountId: "0.0.1001",
    recipientAllowlist: ["0.0.1002"], maxAmountTinybars: "50000000",
    validFromEpochSeconds: "1788508800", expiresAtEpochSeconds: "1788512400",
  };
  const digest = mandateDigest(mandate);
  const reviewRequest = {
    tenantId: mandate.tenantId, scheduleId: "0.0.7001",
    mandateEnvelope: { mandate, signature: Buffer.from(owner.sign(canonicalMandateBytes(mandate))).toString("base64url") },
  };
  const receipt = { success: true, payer: "0.0.8001", transaction: "0.0.7162784@1788537600.000000001", network: "hedera:testnet" as const };
  const facilitator: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.7162784" } }], extensions: [], signers: { "hedera:*": ["0.0.7162784"] } };
    },
    async verify(payload) {
      events.push("verify");
      const bytes = Buffer.from(String(payload.payload.transaction), "base64");
      const valid = payer.publicKey.verifyTransaction(Transaction.fromBytes(bytes));
      return valid ? { isValid: true, payer: "0.0.8001" } : { isValid: false, invalidReason: "invalid_signature" };
    },
    async settle(payload, requirements) {
      const verified = await facilitator.verify(payload, requirements);
      if (!verified.isValid) return { ...receipt, success: false, transaction: "", errorReason: "invalid_signature" };
      events.push("settle");
      const inspected = inspectHederaTransaction(String(payload.payload.transaction));
      assert.deepEqual(inspected.hbarTransfers, [
        { accountId: "0.0.8001", amount: `-${requirements.amount}` },
        { accountId: requirements.payTo, amount: requirements.amount },
      ]);
      return receipt;
    },
  };
  const payment = { resourceUrl: "https://guard.example/review", priceTinybars: "1000000" };
  const paymentGate = await createPaymentGate({
    ...payment,
    operationalAccount: { accountId: "0.0.9001", publicKey: PrivateKey.generateED25519().publicKey },
    treasuryAuthorizations: [{ accountId: mandate.treasuryAccountId, ownerPublicKey: owner.publicKey, agentPublicKey: agent.publicKey, guardPublicKey: guard.publicKey }],
  }, facilitator);
  const dependencies: ReviewServerDependencies = {
    payment, paymentGate, guardPublicKey: guard.publicKey,
    countersign: { guardAccountId: "0.0.3001", protocolMaxFeeTinybars: "100000000", nowEpochSeconds: () => "1788509000", sign: (approval) => countersignTransfer(approval, guard) },
    tenants: new Map([[mandate.tenantId, {
      ownerPublicKey: owner.publicKey, agentPublicKey: agent.publicKey,
      expectedAgentAccountId: "0.0.2001", treasuryAccountId: mandate.treasuryAccountId,
      agentIdentifier: "uaid:aid:agent;nativeId=hedera:testnet:0.0.2001",
    }]]),
    participantIdentifiers: { guard: "uaid:aid:guard;nativeId=hedera:testnet:0.0.3001" },
    lookupCompletedReview: (reservation) => getCompletedMandateReview(databasePath, reservation),
    lookupReviewState: (reservation) => getMandateReviewState(databasePath, reservation),
    reserveNonce: (reservation) => reserveMandateReview(databasePath, reservation),
    completeNonce: (reservation, completion) => completeMandateReview(databasePath, reservation, completion),
    async submitScheduleApproval() { events.push("approve"); },
    async resolveSchedule() {
      events.push("resolve");
      return {
        info: {
          scheduleId: ScheduleId.fromString("0.0.7001"), creatorAccountId: AccountId.fromString("0.0.2001"), payerAccountId: AccountId.fromString("0.0.2001"),
          schedulableTransactionBody: {
            transactionFee: 100000000n, memo: digest,
            cryptoTransfer: { transfers: { accountAmounts: [
              { accountID: { shardNum: 0n, realmNum: 0n, accountNum: 1001n }, amount: -25000000n, isApproval: false },
              { accountID: { shardNum: 0n, realmNum: 0n, accountNum: BigInt(recipient.split(".")[2]) }, amount: 25000000n, isApproval: false },
            ] }, tokenTransfers: [] }, maxCustomFees: [],
          } as unknown as proto.ISchedulableTransactionBody,
          signers: new KeyList([agent.publicKey]), scheduleMemo: digest, adminKey: null,
          expirationTime: new Timestamp(1788512000, 0), executed: null, deleted: null, waitForExpiry: false,
        },
        context: {
          protocolMaxFeeTinybars: "100000000", nowEpochSeconds: "1788509000",
          networkVersions: { protobuf: { major: 0, minor: 64, patch: 0 }, services: { major: 0, minor: 64, patch: 0 } },
          allowedNetworkVersions: { protobuf: "0.64.0", services: "0.64.0" },
        },
      };
    },
    verdictLog: { async record() {
      events.push("record");
      return { topicId: "0.0.9002", sequenceNumber: "1", mirrorNodeUrl: "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9002/messages/1" };
    } },
  };
  const guardOrigin = await listen(t, createReviewServer(dependencies));
  const adapter = createA2aServer({ guardOrigin, publicOrigin: "http://127.0.0.1:0" });
  const origin = await listen(t, adapter);
  const client = new x402HTTPClient(new x402Client().register("hedera:testnet", new ExactHederaScheme(
    createClientHederaSigner("0.0.8001", payer, { network: "hedera:testnet" }),
  )).setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: payment.priceTinybars }] }));
  async function rpc(method: string, params: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${origin}/a2a`, { method: "POST", headers: {
      "content-type": "application/json", "a2a-extensions": A2A_X402_EXTENSION, ...headers,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: "request-id", method, params }) });
    assert.equal(response.status, 200);
    return await response.json() as { result: A2aTask; error?: { code: number; data?: { httpStatus: number } } };
  }
  function message(data: unknown = reviewRequest) {
    return { kind: "message", role: "user", messageId: randomUUID(), parts: [{ kind: "data", data }] };
  }
  async function submitPayment(task: A2aTask, payload?: PaymentPayload) {
    const terms = task.status.message.metadata["x402.payment.required"] as PaymentRequired;
    return { ...message(), taskId: task.id, contextId: task.contextId, metadata: {
      "x402.payment.status": "payment-submitted", "x402.payment.payload": payload ?? await client.createPaymentPayload(terms),
    } };
  }
  return { directory, payer, guard, agent, reviewRequest, dependencies, facilitator, events, receipt, origin, guardOrigin, adapter, client, rpc, message, submitPayment };
}

test("A2A card advertises the review skill and preserves the guard identity and HTTP services", async (t) => {
  const state = await harness(t);
  const response = await fetch(`${state.origin}/.well-known/agent.json`);
  const card = await response.json() as Record<string, unknown>;
  const upstream = await (await fetch(`${state.guardOrigin}/.well-known/agent.json`)).json() as Record<string, unknown>;
  assert.equal(card.protocolVersion, "0.3.0");
  assert.equal(card.preferredTransport, "JSONRPC");
  assert.equal(card.url, `${state.origin}/a2a`);
  assert.deepEqual(card.defaultInputModes, ["application/json"]);
  assert.deepEqual(card.defaultOutputModes, ["application/json"]);
  assert.equal(card.uaid, upstream.uaid);
  assert.equal(card.guardPublicKey, upstream.guardPublicKey);
  assert.equal(card.tenantCount, upstream.tenantCount);
  assert.deepEqual(card.service, upstream.service);
  assert.equal((card.skills as { id: string }[])[0].id, "review");
  assert.deepEqual(await (await fetch(`${state.origin}/.well-known/agent-card.json`)).json(), card);
  assert.deepEqual(state.events, []);
});

test("A2A unpaid task returns the identical HTTP x402 terms and tasks/get retains its state", async (t) => {
  const state = await harness(t);
  const direct = await fetch(`${state.guardOrigin}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.reviewRequest) });
  assert.equal(direct.status, 402);
  const { result: task } = await state.rpc("message/send", { message: state.message() });
  assert.equal(task.kind, "task");
  assert.equal(task.status.state, "input-required");
  assert.equal(task.status.message.taskId, task.id);
  assert.equal(task.status.message.contextId, task.contextId);
  assert.equal(task.status.message.metadata["x402.payment.status"], "payment-required");
  assert.deepEqual(task.status.message.metadata["x402.payment.required"], decodePaymentRequiredHeader(direct.headers.get("payment-required")!));
  assert.deepEqual((await state.rpc("tasks/get", { id: task.id })).result, task);
  assert.deepEqual(state.events, []);
});

for (const recipient of ["0.0.1002", "0.0.9999"]) {
  test(`A2A paid task completes with the real policy verdict for ${recipient}`, async (t) => {
    const state = await harness(t, recipient);
    const { result: task } = await state.rpc("message/send", { message: state.message() });
    const paid = await state.rpc("message/send", { message: await state.submitPayment(task) });
    assert.equal(paid.error, undefined);
    assert.equal(paid.result.id, task.id);
    assert.equal(paid.result.contextId, task.contextId);
    assert.equal(paid.result.status.state, "completed");
    const verdict = paid.result.artifacts![0].parts[0].data;
    assert.equal(verdict.outcome, recipient === "0.0.1002" ? "approved" : "refused");
    assert.equal(verdict.settlementId, state.receipt.transaction);
    assert.deepEqual(paid.result.status.message.metadata["x402.payment.receipts"], [state.receipt]);
    assert.deepEqual(state.events, recipient === "0.0.1002" ? ["verify", "settle", "resolve", "approve", "record"] : ["verify", "settle", "resolve", "record"]);
    assert.deepEqual((await state.rpc("tasks/get", { id: task.id })).result, paid.result);
  });
}

test("A2A rejects malformed review data and invalid mandate signatures before payment", async (t) => {
  const state = await harness(t);
  for (const body of [{}, { ...state.reviewRequest, scheduleId: "invalid" }, { ...state.reviewRequest, unwanted: true }]) {
    const reply = await state.rpc("message/send", { message: state.message(body) });
    assert.equal(reply.error?.code, -32602);
  }
  const badSignature = { ...state.reviewRequest, mandateEnvelope: {
    ...state.reviewRequest.mandateEnvelope,
    signature: Buffer.from(state.agent.sign(canonicalMandateBytes(state.reviewRequest.mandateEnvelope.mandate))).toString("base64url"),
  } };
  assert.equal((await state.rpc("message/send", { message: state.message(badSignature) })).error?.data?.httpStatus, 401);
  assert.deepEqual(state.events, []);
});

test("A2A rejects malformed messages, unknown tasks, methods, and inactive x402 extensions", async (t) => {
  const state = await harness(t);
  for (const message of [{}, { ...state.message(), role: "agent" }, { ...state.message(), messageId: "" }, { ...state.message(), parts: [] }]) {
    assert.equal((await state.rpc("message/send", { message })).error?.code, -32602);
  }
  assert.equal((await state.rpc("tasks/get", { id: "absent" })).error?.code, -32001);
  assert.equal((await state.rpc("tasks/missing", {})).error?.code, -32601);
  assert.equal((await state.rpc("message/send", { message: state.message() }, { "a2a-extensions": "" })).error?.code, -32004);
  const malformed = await fetch(`${state.origin}/a2a`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.deepEqual(await malformed.json(), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON payload" } });
  assert.deepEqual(state.events, []);
});

test("A2A payment cannot replace the task request or context", async (t) => {
  const state = await harness(t);
  const { result: task } = await state.rpc("message/send", { message: state.message() });
  const message = await state.submitPayment(task);
  assert.equal((await state.rpc("message/send", { message: { ...message, parts: [{ kind: "data", data: { ...state.reviewRequest, scheduleId: "0.0.7002" } }] } })).error?.code, -32602);
  assert.equal((await state.rpc("message/send", { message: { ...message, contextId: "other" } })).error?.code, -32602);
  assert.deepEqual(state.events, []);
});

test("A2A failed payment remains unpaid and never resolves or approves the schedule", async (t) => {
  const state = await harness(t);
  t.mock.method(state.facilitator, "verify", async () => ({ isValid: false, invalidReason: "invalid_signature" }));
  const { result: task } = await state.rpc("message/send", { message: state.message() });
  const paid = await state.rpc("message/send", { message: await state.submitPayment(task) });
  assert.equal(paid.result.status.state, "failed");
  assert.equal(paid.result.status.message.metadata["x402.payment.status"], "payment-failed");
  assert.equal(paid.result.status.message.metadata["x402.payment.error"], "PAYMENT_NOT_ACCEPTED");
  assert.equal(paid.result.artifacts, undefined);
  assert.deepEqual(state.events, []);
});

test("A2A concurrent submissions settle once and completed tasks cannot restart", async (t) => {
  const state = await harness(t);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const settle = state.facilitator.settle.bind(state.facilitator);
  t.mock.method(state.facilitator, "settle", async (...args: Parameters<FacilitatorClient["settle"]>) => {
    entered.resolve(); await resume.promise; return settle(...args);
  });
  const { result: task } = await state.rpc("message/send", { message: state.message() });
  const message = await state.submitPayment(task);
  const first = state.rpc("message/send", { message });
  await entered.promise;
  try {
    const second = await state.rpc("message/send", { message });
    assert.equal(second.result.status.state, "working");
    assert.equal((await state.rpc("tasks/get", { id: task.id })).result.status.state, "working");
    assert.equal((await state.rpc("tasks/cancel", { id: task.id })).error?.code, -32002);
  } finally { resume.resolve(); }
  assert.equal((await first).result.status.state, "completed");
  assert.equal((await state.rpc("message/send", { message })).error?.code, -32004);
  assert.equal(state.events.filter((event) => event === "settle").length, 1);
  assert.equal(state.events.filter((event) => event === "approve").length, 1);
});

test("A2A preserves settlement receipts when review fails after payment", async (t) => {
  const state = await harness(t);
  t.mock.method(state.dependencies, "resolveSchedule", async () => { throw new Error("offline consensus unavailable"); });
  const { result: task } = await state.rpc("message/send", { message: state.message() });
  const failed = await state.rpc("message/send", { message: await state.submitPayment(task) });
  assert.equal(failed.result.status.state, "failed");
  assert.equal(failed.result.status.message.metadata["x402.payment.status"], "payment-completed");
  assert.deepEqual(failed.result.status.message.metadata["x402.payment.receipts"], [state.receipt]);
  assert.equal(failed.result.artifacts, undefined);
  assert.deepEqual(state.events, ["verify", "settle"]);
});

test("A2A counterparty script settles a task end to end with offline Hedera and facilitator responses", async (t) => {
  const state = await harness(t);
  const requestPath = resolve(state.directory, "review-request.json");
  writeFileSync(requestPath, JSON.stringify(state.reviewRequest));
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--experimental-strip-types", "scripts/a2a-client.ts", requestPath,
  ], { cwd: process.cwd(), env: {
    ...process.env,
    COUNTERSIGN_PAYER_ACCOUNT_ID: "0.0.8001", COUNTERSIGN_PAYER_PRIVATE_KEY: state.payer.toStringDer(),
    COUNTERSIGN_A2A_MAX_PAYMENT_TINYBARS: "1000000", COUNTERSIGN_A2A_ORIGIN: state.origin,
    COUNTERSIGN_GUARD_UAID: state.dependencies.participantIdentifiers.guard,
    COUNTERSIGN_GUARD_PUBLIC_KEY: state.guard.publicKey.toString(), COUNTERSIGN_FEE_ACCOUNT_ID: "0.0.9001",
  } });
  assert.match(stdout, /Task settlement over A2A, not open-ended negotiation/);
  const events = stdout.trim().split(/\r?\n/).slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events.map((event) => event.event), ["agent-card", "payment-required", "completed"]);
  assert.equal((events[2].verdict as Record<string, unknown>).outcome, "approved");
  assert.deepEqual(state.events, ["verify", "settle", "resolve", "approve", "record"]);
  t.diagnostic("OFFLINE DEMONSTRATION: real HTTP, x402 signing, payment gate, policy review and SQLite; simulated consensus, facilitator settlement and HCS receipt.");
  t.diagnostic(stdout);
});

test("A2A client refuses changed guard identity and unauthorized payment terms before signing", async (t) => {
  const state = await harness(t);
  let signatures = 0;
  const options = {
    origin: state.origin, expectedUaid: state.dependencies.participantIdentifiers.guard,
    expectedGuardPublicKey: state.guard.publicKey.toString(), expectedPayTo: "0.0.9001",
    maxAmountTinybars: "1000000", payerAccountId: "0.0.8001", reviewRequest: state.reviewRequest,
    createPaymentPayload: async (terms: PaymentRequired) => { signatures += 1; return state.client.createPaymentPayload(terms); },
  };
  await assert.rejects(settleA2aReview({ ...options, expectedUaid: "other" }), /expected guard/);
  await assert.rejects(settleA2aReview({ ...options, expectedGuardPublicKey: state.agent.publicKey.toString() }), /expected guard/);
  await assert.rejects(settleA2aReview({ ...options, maxAmountTinybars: "1" }), /configured authorization/);
  await assert.rejects(settleA2aReview({ ...options, expectedPayTo: "0.0.9999" }), /configured authorization/);
  await assert.rejects(settleA2aReview({ ...options, payerAccountId: "0.0.7162784" }), /configured authorization/);
  assert.equal(signatures, 0);
  assert.deepEqual(state.events, []);
});

test("A2A malformed upstream verdict becomes a failed task with its settlement receipt retained", async (t) => {
  const state = await harness(t);
  const upstream = createServer((request, response) => {
    if (request.headers["payment-signature"] !== undefined) {
      response.writeHead(200, { "content-type": "application/json", "payment-response": encodePaymentResponseHeader(state.receipt) });
      response.end("null");
      return;
    }
    void (async () => {
      const result = await state.dependencies.paymentGate.review();
      assert.equal(result.paid, false);
      if (!result.paid) {
        response.writeHead(402, result.headers);
        response.end(JSON.stringify(result.body));
      }
    })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error("Fixture failed")));
  });
  const guardOrigin = await listen(t, upstream);
  const origin = await listen(t, createA2aServer({ guardOrigin, publicOrigin: "http://127.0.0.1:0" }));
  const send = async (message: unknown) => {
    const result = await fetch(`${origin}/a2a`, {
      method: "POST", headers: { "content-type": "application/json", "a2a-extensions": A2A_X402_EXTENSION },
      body: JSON.stringify({ jsonrpc: "2.0", id: "malformed-verdict", method: "message/send", params: { message } }),
    });
    return await result.json() as { result: A2aTask; error?: unknown };
  };
  const task = (await send(state.message())).result;
  const result = await send(await state.submitPayment(task));
  assert.equal(result.error, undefined);
  assert.equal(result.result.status.state, "failed");
  assert.deepEqual(result.result.status.message.metadata["x402.payment.receipts"], [state.receipt]);
});

test("A2A rejects invalid upstream payment evidence without completing the task", async (t) => {
  const state = await harness(t);
  const receipt = state.receipt;
  const cases: {
    name: string;
    receipt: unknown;
    verdict?: Record<string, unknown>;
    unpaid?: boolean;
    retainReceipt?: boolean;
  }[] = [
    ...["approved", "refused"].map((outcome) => ({
      name: `${outcome} verdict settlementId differs from receipt transaction`, receipt, retainReceipt: true,
      verdict: { outcome, settlementId: "0.0.7162784@1788537600.000000002" },
    })),
    { name: "verdict without a payment-signature header", receipt, unpaid: true, retainReceipt: true },
    { name: "verdict with zero receipts", receipt: undefined },
    { name: "verdict with an unsuccessful receipt", receipt: { ...receipt, success: false }, retainReceipt: true },
    { name: "verdict with an unsupported outcome", receipt, retainReceipt: true,
      verdict: { outcome: "pending", settlementId: receipt.transaction } },
    { name: "verdict missing settlementId", receipt, retainReceipt: true, verdict: { outcome: "approved" } },
    { name: "verdict with a non-string settlementId", receipt, retainReceipt: true,
      verdict: { outcome: "approved", settlementId: 123 } },
    { name: "null receipt", receipt: null },
    { name: "string receipt", receipt: "receipt" },
    { name: "numeric receipt", receipt: 123 },
    { name: "boolean receipt", receipt: true },
    { name: "empty receipt array", receipt: [] },
    { name: "multiple receipts in the payment-response header", receipt: [receipt, { ...receipt, transaction: "0.0.7162784@1788537600.000000002" }] },
    { name: "receipt missing all required fields", receipt: {} },
    { name: "receipt missing success", receipt: { transaction: receipt.transaction, network: receipt.network } },
    { name: "receipt missing transaction", receipt: { success: true, network: receipt.network } },
    { name: "receipt missing network", receipt: { success: true, transaction: receipt.transaction } },
    { name: "receipt with non-boolean success", receipt: { ...receipt, success: "true" } },
    { name: "receipt with non-string transaction", receipt: { ...receipt, transaction: 123 } },
    { name: "receipt with non-string network", receipt: { ...receipt, network: 123 } },
    { name: "successful receipt with an empty transaction", receipt: { ...receipt, transaction: "" },
      verdict: { outcome: "approved", settlementId: "" } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      let message: unknown = state.message();
      let task: A2aTask | undefined;
      if (!entry.unpaid) {
        const reply = await state.rpc("message/send", { message });
        assert.equal(reply.error, undefined);
        task = reply.result;
        assert.equal(task.status.state, "input-required");
        message = await state.submitPayment(task);
      }
      const originalFetch = globalThis.fetch;
      const paymentHeaders: (string | null)[] = [];
      t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) !== `${state.guardOrigin}/review`) return originalFetch(url, init);
        paymentHeaders.push(new Headers(init?.headers).get("payment-signature"));
        return Response.json(entry.verdict ?? { outcome: "approved", settlementId: receipt.transaction }, {
          headers: entry.receipt === undefined ? {} : {
            "payment-response": Buffer.from(JSON.stringify(entry.receipt)).toString("base64"),
          },
        });
      });
      const reply = await state.rpc("message/send", { message });
      assert.equal(paymentHeaders.length, 1);
      if (entry.unpaid) assert.equal(paymentHeaders[0], null);
      else assert.ok(paymentHeaders[0]);
      assert.equal(reply.error, undefined);
      assert.equal(reply.result.status.state, "failed");
      assert.equal(reply.result.artifacts, undefined);
      assert.equal(reply.result.status.message.metadata["x402.payment.error"], "GUARD_RESPONSE_UNAVAILABLE");
      assert.deepEqual(reply.result.status.message.metadata["x402.payment.receipts"], entry.retainReceipt ? [entry.receipt] : []);
      if (task !== undefined) {
        assert.equal(reply.result.id, task.id);
        assert.equal(reply.result.contextId, task.contextId);
      }
      assert.deepEqual((await state.rpc("tasks/get", { id: reply.result.id })).result, reply.result);
      assert.deepEqual(state.events, []);
    });
  }
});

test("A2A rejects oversized review and JSON-RPC bodies before payment", async (t) => {
  const state = await harness(t);
  assert.equal((await state.rpc("message/send", { message: state.message({ text: "x".repeat(16 * 1024) }) })).error?.code, -32602);
  const response = await fetch(`${state.origin}/a2a`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(64 * 1024) }),
  });
  const body = await response.json() as { error: { code: number } };
  assert.equal(body.error.code, -32600);
  assert.deepEqual(state.events, []);
});

test("A2A payment authorization cannot use a treasury authorization key", async (t) => {
  const state = await harness(t);
  const payer = new x402HTTPClient(new x402Client().register("hedera:testnet", new ExactHederaScheme(
    createClientHederaSigner("0.0.8001", state.agent, { network: "hedera:testnet" }),
  )).setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: "1000000" }] }));
  const { result: task } = await state.rpc("message/send", { message: state.message() });
  const payload = await payer.createPaymentPayload(task.status.message.metadata["x402.payment.required"] as PaymentRequired);
  const rejected = await state.rpc("message/send", { message: await state.submitPayment(task, payload) });
  assert.equal(rejected.result.status.state, "input-required");
  assert.equal(rejected.result.status.message.metadata["x402.payment.status"], "payment-failed");
  assert.deepEqual(state.events, []);
});

test("A2A cancels unpaid tasks and rejects payment after cancellation", async (t) => {
  const state = await harness(t);
  const { result: task } = await state.rpc("message/send", { message: state.message() });
  const message = await state.submitPayment(task);
  const canceled = await state.rpc("tasks/cancel", { id: task.id });
  assert.equal(canceled.result.status.state, "canceled");
  assert.equal((await state.rpc("message/send", { message })).error?.code, -32004);
  assert.equal((await state.rpc("tasks/cancel", { id: task.id })).error?.code, -32002);
  assert.deepEqual(state.events, []);
});

test("A2A permits declining payment terms through the x402 extension", async (t) => {
  const state = await harness(t);
  const { result: task } = await state.rpc("message/send", { message: state.message() });
  const rejected = await state.rpc("message/send", { message: {
    ...state.message(), taskId: task.id, metadata: { "x402.payment.status": "payment-rejected" },
  } });
  assert.equal(rejected.result.status.state, "canceled");
  assert.equal(rejected.result.status.message.metadata["x402.payment.status"], "payment-rejected");
  assert.deepEqual(state.events, []);
});
