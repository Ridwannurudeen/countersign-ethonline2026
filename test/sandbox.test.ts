import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client, PrivateKey, Transaction } from "@hiero-ledger/sdk";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { inspectHederaTransaction } from "@x402/hedera";
import { clientAddress, createSandbox, parseProposal, parseSandboxConfiguration, productionDependencies, type SandboxDependencies } from "../scripts/serve-sandbox.ts";
import { mandateDigest, type MandateEnvelope } from "../src/mandate.ts";

const proposal = { recipient: "vendor", amountTinybars: "1000000" };
const hcsVerdictUrl = "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.100/messages/1";
const dependencies: SandboxDependencies = {
  async checkBalances() { return true; },
  async createSchedule(_proposal, envelope) { return `0.0.${envelope.mandate.nonce}`; },
  async review(_envelope, _scheduleId, paid) {
    paid("0.0.10@123.000000001");
    return { outcome: "approved", hcsVerdictUrl };
  },
};
function fixture(t: TestContext, count = 3, overrides: Partial<SandboxDependencies> = {}, now = Date.now) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const envelopes: MandateEnvelope[] = Array.from({ length: count }, (_, index) => ({
    mandate: { tenantId: "sandbox", nonce: String(index + 1), treasuryAccountId: "0.0.10",
      recipientAllowlist: ["0.0.11"], maxAmountTinybars: "50000000", validFromEpochSeconds: "1", expiresAtEpochSeconds: "9999999999" },
    signature: "A".repeat(86),
  }));
  return { sandbox: createSandbox(envelopes, database, { ...dependencies, ...overrides }, now), database, envelopes };
}
async function* body(value: unknown = proposal) { yield Buffer.from(JSON.stringify(value)); }
const post = (sandbox: ReturnType<typeof createSandbox>, address = "127.0.0.1", value: unknown = proposal) =>
  sandbox.handle("POST", "/sandbox/run", address, body(value));

test("sandbox validates recipient and minimal bounded decimal amounts", async t => {
  const { sandbox } = fixture(t);
  for (const value of [null, [], {}, { ...proposal, extra: true }, { ...proposal, recipient: "owner" },
    ...[null, [], {}, { toString: null }].map(recipient => ({ ...proposal, recipient })),
    ...[1, null, "", "01000000", "1000000.0", "1e6", "+1000000", " 1000000", "999999", "100000001", "9".repeat(100)].map(amountTinybars => ({ ...proposal, amountTinybars }))]) {
    assert.equal((await post(sandbox, "ip", value)).status, 400);
  }
  for (const recipient of ["vendor", "stranger", "agent"]) {
    for (const amountTinybars of ["1000000", "100000000"]) {
      assert.deepEqual(parseProposal({ recipient, amountTinybars }), { recipient, amountTinybars });
    }
  }
});

test("sandbox rejects malformed JSON and oversized chunked bodies before reserving an envelope", async t => {
  const { sandbox } = fixture(t, 1);
  async function* malformed() { yield Buffer.from("{"); }
  async function* oversized() { yield Buffer.alloc(4096); yield Buffer.alloc(4097); throw new Error("must stop reading"); }
  for (const stream of [malformed(), oversized()]) {
    assert.equal((await sandbox.handle("POST", "/sandbox/run", "ip", stream)).status, 400);
  }
  assert.equal((await post(sandbox)).status, 202);
  await sandbox.idle();
});

test("sandbox serializes complete runs, reserves concurrent capacity and preserves ascending nonces", async t => {
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const { sandbox } = fixture(t, 2, {
    async checkBalances() { events.push("balance"); return true; },
    async createSchedule(_proposal, envelope) {
      events.push(`schedule:${envelope.mandate.nonce}`);
      if (envelope.mandate.nonce === "1") await release.promise;
      return `0.0.${envelope.mandate.nonce}`;
    },
    async review(envelope, _schedule, paid) {
      events.push(`review:${envelope.mandate.nonce}`);
      paid("settlement");
      return { outcome: "approved", hcsVerdictUrl };
    },
  });
  assert.equal((await post(sandbox, "first")).status, 202);
  const second = post(sandbox, "second");
  assert.equal((await post(sandbox, "third")).status, 503);
  assert.deepEqual(events, ["balance", "schedule:1"]);
  release.resolve();
  assert.equal((await second).status, 202);
  await sandbox.idle();
  assert.deepEqual(events, ["balance", "schedule:1", "review:1", "balance", "schedule:2", "review:2"]);
});

test("sandbox bounds waiting runs and rejects busy requests without consuming their token or envelope", async t => {
  const release = Promise.withResolvers<void>();
  const nonces: string[] = [];
  const { sandbox } = fixture(t, 4, {
    async createSchedule(_proposal, envelope) {
      nonces.push(envelope.mandate.nonce);
      if (envelope.mandate.nonce === "1") await release.promise;
      return `0.0.${envelope.mandate.nonce}`;
    },
  }, () => 0);
  assert.equal((await post(sandbox, "first")).status, 202);
  const second = post(sandbox, "second");
  const third = post(sandbox, "third");
  const fourth = post(sandbox, "fourth");
  try {
    const busy = await Promise.race([fourth, new Promise<null>(resolve => setImmediate(() => resolve(null)))]);
    assert.ok(busy !== null, "busy admission must respond without waiting for the active run");
    assert.equal(busy.status, 503);
    assert.ok("error" in busy.body);
    assert.equal(busy.body.error, "sandbox busy; try again shortly");
    assert.equal((await post(sandbox, "first")).status, 429);
    assert.deepEqual(nonces, ["1"]);
  } finally {
    release.resolve();
    await Promise.all([second, third, fourth]);
    await sandbox.idle();
  }
  assert.equal((await second).status, 202);
  assert.equal((await third).status, 202);
  assert.deepEqual(nonces, ["1", "2", "3"]);
  assert.equal((await post(sandbox, "fourth")).status, 202);
  await sandbox.idle();
  assert.deepEqual(nonces, ["1", "2", "3", "4"]);
  const exhausted = await post(sandbox, "fifth");
  assert.equal(exhausted.status, 503);
  assert.ok("error" in exhausted.body);
  assert.equal(exhausted.body.error, "sandbox pre-signed envelopes exhausted");
});

test("sandbox exhaustion survives restart and retains honest linkable evidence", async t => {
  const { sandbox, database, envelopes } = fixture(t, 1);
  const accepted = await post(sandbox);
  assert.equal(accepted.status, 202);
  assert.ok("runId" in accepted.body);
  await sandbox.idle();
  const restarted = createSandbox(envelopes, database, dependencies);
  const exhausted = await post(restarted, "another");
  assert.equal(exhausted.status, 503);
  assert.ok("error" in exhausted.body);
  assert.match(exhausted.body.error, /pre-signed envelopes exhausted/);
  const result = await restarted.handle("GET", `/sandbox/run/${accepted.body.runId}`, "ip", body());
  assert.equal(result.status, 200);
  assert.ok("steps" in result.body);
  assert.deepEqual(result.body.steps.map(step => step.state), ["done", "done", "done", "done"]);
  assert.equal(result.body.hcsVerdictUrl, hcsVerdictUrl);
  assert.equal(result.body.scheduleId, "0.0.1");
  assert.equal(result.body.settlementId, "0.0.10@123.000000001");
  for (const response of [accepted, exhausted, result, await restarted.handle("GET", "/sandbox/runs", "ip", body())]) {
    assert.equal(response.body.origin, "operator");
    assert.match(response.body.disclosure, /operator-owned.*operator-run reliability exercises, not users/);
  }
  assert.throws(() => createSandbox([...envelopes, envelopes[0]], database, dependencies), /persisted run budget/);
});

test("sandbox checks the balance floor again after a preceding run spends funds", async t => {
  let funded = true;
  const { sandbox } = fixture(t, 2, {
    async checkBalances() { return funded; },
    async review(_envelope, _schedule, paid) { funded = false; paid("settlement"); return { outcome: "approved", hcsVerdictUrl }; },
  });
  assert.equal((await post(sandbox, "first")).status, 202);
  const denied = await post(sandbox, "second");
  assert.equal(denied.status, 503);
  assert.ok("error" in denied.body);
  assert.equal(denied.body.error, "sandbox budget exhausted");
  funded = true;
  assert.equal((await post(sandbox, "third")).status, 202);
  await sandbox.idle();
});

test("sandbox token bucket has one token, refills after 30 seconds and separates addresses", async t => {
  let now = 0;
  const { sandbox } = fixture(t, 5, {}, () => now);
  assert.equal((await post(sandbox, "a")).status, 202);
  await sandbox.idle();
  now = 29_999;
  assert.equal((await post(sandbox, "a")).status, 429);
  assert.equal((await post(sandbox, "b")).status, 202);
  await sandbox.idle();
  now = 30_000;
  assert.equal((await post(sandbox, "a")).status, 202);
  await sandbox.idle();
});

test("sandbox failures leave later steps never-happened and do not reuse envelopes", async t => {
  const { sandbox } = fixture(t, 2, { async createSchedule() { throw new Error("private upstream detail"); } });
  const result = await post(sandbox);
  assert.ok("runId" in result.body);
  await sandbox.idle();
  const detail = await sandbox.handle("GET", `/sandbox/run/${result.body.runId}`, "ip", body());
  assert.ok("steps" in detail.body);
  assert.deepEqual(detail.body.steps.map(step => step.state), ["done", "failed", "never-happened", "never-happened"]);
  assert.equal(detail.body.outcome, "failed");
  assert.ok(!JSON.stringify(detail.body).includes("private upstream detail"));
  assert.equal((await post(sandbox, "next")).status, 202);
  await sandbox.idle();
  assert.equal((await post(sandbox, "last")).status, 503);
});

test("sandbox lists only the last 20 runs after the budget is spent", async t => {
  const { sandbox } = fixture(t, 21);
  for (let index = 0; index < 21; index += 1) {
    assert.equal((await post(sandbox, String(index))).status, 202);
    await sandbox.idle();
  }
  const result = await sandbox.handle("GET", "/sandbox/runs", "ip", body());
  assert.ok("runs" in result.body);
  assert.equal(result.body.runs.length, 20);
  assert.equal(result.body.runs[0].scheduleId, "0.0.21");
  assert.equal(result.body.runs[19].scheduleId, "0.0.2");
  assert.ok(result.body.runs.every(run => run.origin === "operator"));
});

test("sandbox entrypoint fails fast naming the first missing variable", () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("COUNTERSIGN_")) delete env[name];
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/serve-sandbox.ts"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required environment variable: COUNTERSIGN_TENANT_ID/);
});

test("sandbox payer signs a bounded x402 payment and checks guard evidence offline", async t => {
  const payerKey = PrivateKey.generateED25519();
  const env: NodeJS.ProcessEnv = {
    COUNTERSIGN_TENANT_ID: "sandbox", COUNTERSIGN_GUARD_ORIGIN: "https://guard.example",
    COUNTERSIGN_TREASURY_ACCOUNT_ID: "0.0.10", COUNTERSIGN_AGENT_ACCOUNT_ID: "0.0.20",
    COUNTERSIGN_AGENT_PRIVATE_KEY: PrivateKey.generateED25519().toStringDer(),
    COUNTERSIGN_PAYER_ACCOUNT_ID: "0.0.30", COUNTERSIGN_PAYER_PRIVATE_KEY: payerKey.toStringDer(),
    COUNTERSIGN_VENDOR_ACCOUNT_ID: "0.0.11", COUNTERSIGN_STRANGER_ACCOUNT_ID: "0.0.12",
  };
  for (const name of ["COUNTERSIGN_OWNER_PRIVATE_KEY", "COUNTERSIGN_GUARD_PRIVATE_KEY"]) {
    Object.defineProperty(env, name, { get() { assert.fail("service must not read authorization private keys"); } });
  }
  const config = parseSandboxConfiguration(env);
  assert.equal(config.port, 4030);
  assert.equal(config.floor, 100000000n);
  const client = Client.forTestnet();
  t.after(() => client.close());
  const production = productionDependencies(config, client);
  const { envelopes } = fixture(t, 1);
  const envelope = envelopes[0];
  const required: PaymentRequired = { x402Version: 2, resource: { url: "https://guard.example/review", description: "Authorization review", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: "1000000", payTo: "0.0.40", maxTimeoutSeconds: 60, extra: { feePayer: "0.0.50" } }] };
  let calls = 0;
  let mismatch = false;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(url), "https://guard.example/review");
    assert.equal(init?.body, JSON.stringify({ tenantId: "sandbox", mandateEnvelope: envelope, scheduleId: "0.0.60" }));
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (calls % 2 === 1) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } });
    const signature = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
    assert.ok(signature);
    const transaction = decodePaymentSignatureHeader(signature).payload.transaction;
    assert.equal(typeof transaction, "string");
    if (typeof transaction !== "string") assert.fail("expected signed payment transaction");
    assert.deepEqual(inspectHederaTransaction(transaction).hbarTransfers, [
      { accountId: "0.0.30", amount: "-1000000" }, { accountId: "0.0.40", amount: "1000000" },
    ]);
    assert.ok(payerKey.publicKey.verifyTransaction(Transaction.fromBytes(Buffer.from(transaction, "base64"))));
    return Response.json({ outcome: "refused", reason: "recipient is outside the authorization policy", scheduleId: mismatch ? "0.0.61" : "0.0.60",
      mandateDigest: mandateDigest(envelope.mandate), settlementId: "0.0.50@123.000000001", mirrorNodeUrl: hcsVerdictUrl },
    { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: "0.0.50@123.000000001", network: "hedera:testnet", payer: "0.0.30" }) } });
  });
  const settlements: string[] = [];
  const verdict = await production.review(envelope, "0.0.60", id => settlements.push(id));
  assert.equal(verdict.outcome, "refused");
  assert.equal(verdict.hcsVerdictUrl, hcsVerdictUrl);
  assert.deepEqual(settlements, ["0.0.50@123.000000001"]);
  mismatch = true;
  await assert.rejects(production.review(envelope, "0.0.60", id => settlements.push(id)), /evidence does not match/);
  assert.equal(settlements.length, 2);
  required.accepts[0].amount = "1000001";
  await assert.rejects(production.review(envelope, "0.0.60", () => assert.fail("must not settle")), /payment policy/);
  assert.equal(calls, 5);
});

test("sandbox restart marks interrupted work unknown without retrying it", async t => {
  const { sandbox, database, envelopes } = fixture(t, 1);
  const accepted = await post(sandbox);
  assert.ok("runId" in accepted.body);
  await sandbox.idle();
  const detail = await sandbox.handle("GET", `/sandbox/run/${accepted.body.runId}`, "ip", body());
  assert.ok("steps" in detail.body);
  detail.body.outcome = "running";
  detail.body.steps[2].state = "running";
  detail.body.steps[3].state = "pending";
  delete detail.body.settlementId;
  delete detail.body.hcsVerdictUrl;
  database.prepare("UPDATE sandbox_runs SET record = ? WHERE position = 0").run(JSON.stringify(detail.body));
  const restarted = createSandbox(envelopes, database, { ...dependencies, async checkBalances() { assert.fail("must not retry"); } });
  const recovered = await restarted.handle("GET", `/sandbox/run/${accepted.body.runId}`, "ip", body());
  assert.ok("steps" in recovered.body);
  assert.equal(recovered.body.outcome, "failed");
  assert.match(recovered.body.reason!, /unknown/);
  assert.deepEqual(recovered.body.steps.map(step => step.state), ["done", "done", "failed", "never-happened"]);
  assert.equal((await post(restarted)).status, 503);
});

test("clientAddress keeps the rate limit per visitor behind the reverse proxy", () => {
  // Behind nginx every socket peer is 127.0.0.1, so the proxy's X-Real-IP is what distinguishes visitors.
  assert.equal(clientAddress("127.0.0.1", "203.0.113.7"), "203.0.113.7");
  assert.equal(clientAddress("127.0.0.1", ["203.0.113.7", "198.51.100.4"]), "203.0.113.7");
  assert.equal(clientAddress("127.0.0.1", "2001:db8::1"), "2001:db8::1");
  for (const forged of [undefined, "", "not an address", "203.0.113.7 ; rm", "a".repeat(46)]) {
    assert.equal(clientAddress("127.0.0.1", forged), "127.0.0.1");
  }
  assert.equal(clientAddress(undefined, undefined), "unknown");
});

test("sandbox mandates may start above the guard's high-water mark, but must stay contiguous", async t => {
  // A replacement set cannot restart at nonce 1: the guard keeps an ascending high-water mark
  // per tenant, so re-signing from 1 turns the first envelopes into paid refusals for the
  // recipient the owner actually allowed.
  const { sandbox, envelopes } = fixture(t, 3);
  const shifted = envelopes.map((envelope, index) => ({
    ...envelope,
    mandate: { ...envelope.mandate, nonce: String(1001 + index) },
  }));
  assert.equal(shifted[0]!.mandate.nonce, "1001");
  assert.equal(shifted.at(-1)!.mandate.nonce, String(1000 + shifted.length));
  const first = BigInt(shifted[0]!.mandate.nonce);
  for (const [index, envelope] of shifted.entries()) {
    assert.equal(BigInt(envelope.mandate.nonce), first + BigInt(index));
  }
  const gap = shifted.map((envelope, index) =>
    index === 1 ? { ...envelope, mandate: { ...envelope.mandate, nonce: "9999" } } : envelope);
  assert.notEqual(BigInt(gap[1]!.mandate.nonce), first + 1n);
  assert.equal((await post(sandbox)).status, 202);
  await sandbox.idle();
});
