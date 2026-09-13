import assert from "node:assert/strict";
import test from "node:test";

import { proto } from "@hiero-ledger/proto";
import { PrivateKey, Transaction } from "@hiero-ledger/sdk";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, x402HTTPClient } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/facilitator";
import { ExactHederaScheme as ClientHederaScheme } from "@x402/hedera/exact/client";

import { createPaymentGate } from "../src/payment-gate.ts";
import { DEFAULT_COUNTERSIGN_METER, quoteCountersign } from "../src/payment-meter.ts";

function transactionBytes(memo = "", adjustments = 2, variants = 1): string {
  const bodyBytes = proto.TransactionBody.encode({
    memo,
    cryptoTransfer: {
      transfers: { accountAmounts: Array.from({ length: adjustments }, () => ({})) },
    },
  }).finish();
  const signedTransactionBytes = proto.SignedTransaction.encode({ bodyBytes }).finish();
  return Buffer.from(proto.TransactionList.encode({
    transactionList: Array.from({ length: variants }, () => ({ signedTransactionBytes })),
  }).finish()).toString("base64");
}

const config = {
  resourceUrl: "https://guard.example/review",
  priceTinybars: "1000000",
  operationalAccount: { accountId: "0.0.9001", publicKey: PrivateKey.generateED25519().publicKey },
  treasuryAuthorizations: [{
    accountId: "0.0.1001",
    ownerPublicKey: PrivateKey.generateED25519().publicKey,
    agentPublicKey: PrivateKey.generateED25519().publicKey,
    guardPublicKey: PrivateKey.generateED25519().publicKey,
  }],
};

const facilitator = {
  async getSupported() {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet" as const, extra: { feePayer: "0.0.7162784" } }],
      extensions: [], signers: { "hedera:*": ["0.0.7162784"] },
    };
  },
  async verify(): Promise<never> { assert.fail("an unpaid quote must not verify a payment"); },
  async settle(): Promise<never> { assert.fail("an unpaid quote must not settle a payment"); },
};

test("countersign quotes increase with decoded bytes and adjustments, while review stays flat", async () => {
  const gate = await createPaymentGate(config, facilitator);
  const amounts: bigint[] = [];
  for (const transactionBase64 of [transactionBytes(), transactionBytes("x"), transactionBytes("x", 3)]) {
    const outcome = await gate.review(undefined, "/countersign", transactionBase64);
    assert.ok(!outcome.paid);
    const required = decodePaymentRequiredHeader(outcome.headers["PAYMENT-REQUIRED"]);
    amounts.push(BigInt(required.accepts[0].amount));
    assert.equal(required.accepts[0].asset, "0.0.0");
  }
  assert.ok(amounts[1] > amounts[0], "more decoded bytes must increase the quote");
  assert.ok(amounts[2] > amounts[1], "more adjustments must increase the quote");
  const review = await gate.review();
  assert.ok(!review.paid);
  assert.equal(decodePaymentRequiredHeader(review.headers["PAYMENT-REQUIRED"]).accepts[0].amount, config.priceTinybars);
});

test("meter is reproducible from the submitted bytes and publishes every charge component", async () => {
  const input = transactionBytes("policy", 4, 2);
  const expected = quoteCountersign(input);
  assert.deepEqual(quoteCountersign(input), expected);
  assert.equal(expected.decodedBytes, Buffer.from(input, "base64").length);
  assert.equal(expected.transferAdjustments, 8);
  assert.equal(expected.decodeStatus, "decoded");
  const gate = await createPaymentGate(config, facilitator);
  for (let retry = 0; retry < 2; retry++) {
    const outcome = await gate.review(undefined, "/countersign", input);
    assert.ok(!outcome.paid);
    const required = decodePaymentRequiredHeader(outcome.headers["PAYMENT-REQUIRED"]);
    assert.deepEqual(required.accepts[0].extra?.meter, expected);
    assert.equal(required.accepts[0].amount, expected.amountTinybars);
    assert.equal(required.accepts[0].extra?.paymentFlow, "upfront");
    assert.equal(outcome.headers["Cache-Control"], "no-store");
  }
  const { decodedBytes, transferAdjustments, perKilobyteTinybars, perAdjustmentTinybars, baseTinybars } = expected;
  const reproduced = BigInt(baseTinybars) +
    (BigInt(decodedBytes) * BigInt(perKilobyteTinybars) + 1023n) / 1024n +
    BigInt(transferAdjustments) * BigInt(perAdjustmentTinybars);
  assert.equal(expected.amountTinybars, reproduced.toString());
});

test("each additional byte is charged before the ceiling, including within a kilobyte", () => {
  const small = quoteCountersign(transactionBytes("a"));
  const larger = quoteCountersign(transactionBytes("aa"));
  assert.equal(larger.decodedBytes - small.decodedBytes, 1);
  assert.equal(BigInt(larger.amountTinybars) - BigInt(small.amountTinybars), 100n);
  const rounded = quoteCountersign(transactionBytes("a"), { ...DEFAULT_COUNTERSIGN_METER, perKilobyteTinybars: "1" });
  assert.equal(rounded.byteChargeTinybars, "1", "fractional tinybars round up");
});

test("adjustments add a charge independently of byte length", () => {
  const fewer = quoteCountersign(transactionBytes("xx", 2));
  const more = quoteCountersign(transactionBytes("", 3));
  assert.equal(fewer.decodedBytes, more.decodedBytes);
  assert.equal(BigInt(more.amountTinybars) - BigInt(fewer.amountTinybars), 10000n);
});

test("meter counts every node variant, HBAR, fungible token and NFT transfer entry", () => {
  const bodyBytes = proto.TransactionBody.encode({
    cryptoTransfer: {
      transfers: { accountAmounts: [{}, {}] },
      tokenTransfers: [
        { transfers: [{}, {}, {}] },
        { transfers: [{}], nftTransfers: [{}, {}] },
      ],
    },
  }).finish();
  const signedTransactionBytes = proto.SignedTransaction.encode({ bodyBytes }).finish();
  const bytes = proto.TransactionList.encode({ transactionList: [{ signedTransactionBytes }, { signedTransactionBytes }] }).finish();
  const quote = quoteCountersign(Buffer.from(bytes).toString("base64"));
  assert.equal(quote.transferAdjustments, 16);
  assert.equal(quote.adjustmentChargeTinybars, "160000");
});

test("configured ceiling caps a crafted adjustment-heavy transaction", () => {
  const quote = quoteCountersign(transactionBytes("", 5000));
  assert.ok(BigInt(quote.subtotalTinybars) > BigInt(DEFAULT_COUNTERSIGN_METER.maxTinybars));
  assert.equal(quote.amountTinybars, DEFAULT_COUNTERSIGN_METER.maxTinybars);
});

test("configured floor holds for empty, malformed and small decoded inputs", () => {
  const meter = { ...DEFAULT_COUNTERSIGN_METER, minTinybars: "2000000" };
  for (const input of ["", "!", "////", transactionBytes()]) {
    const quote = quoteCountersign(input, meter);
    assert.equal(quote.amountTinybars, "2000000");
    assert.ok(BigInt(quote.amountTinybars) > 0n);
  }
});

test("integer arithmetic remains exact above the safe-number range and clamps to int64", () => {
  const max = "9223372036854775807";
  const quote = quoteCountersign(transactionBytes("policy", 100), {
    baseTinybars: max, perKilobyteTinybars: max, perAdjustmentTinybars: max, minTinybars: "1", maxTinybars: max,
  });
  assert.equal(quote.adjustmentChargeTinybars, (100n * BigInt(max)).toString());
  assert.ok(BigInt(quote.subtotalTinybars) > BigInt(max));
  assert.equal(quote.amountTinybars, max);
});

test("malformed byte inputs disclose unavailable adjustments without changing policy refusal behavior", () => {
  const partialList = proto.TransactionList.decode(Buffer.from(transactionBytes(), "base64"));
  partialList.transactionList.push(proto.Transaction.create({ signedTransactionBytes: Buffer.from([255]) }));
  for (const input of ["", "!", "AAAA", "////", `${transactionBytes()}\n`, Buffer.from(proto.TransactionList.encode(partialList).finish()).toString("base64")]) {
    const quote = quoteCountersign(input);
    assert.equal(quote.decodeStatus, "invalid");
    assert.equal(quote.transferAdjustments, 0);
    assert.equal(quote.decodedBytes, Buffer.from(input, "base64").length);
    assert.ok(BigInt(quote.amountTinybars) >= BigInt(quote.minTinybars));
    assert.ok(BigInt(quote.amountTinybars) <= BigInt(quote.maxTinybars));
  }
  assert.throws(() => quoteCountersign("A".repeat(16 * 1024 + 1)), /size limit/);
});

test("meter rejects invalid rates and bounds at startup", async (t) => {
  for (const field of ["baseTinybars", "perKilobyteTinybars", "perAdjustmentTinybars", "minTinybars", "maxTinybars"] as const) {
    await t.test(field, async () => {
      for (const value of ["0", "-1", "01", "1.5", "1e6", "9223372036854775808", "9".repeat(1000)]) {
        await assert.rejects(createPaymentGate({
          ...config, countersignMeter: { ...DEFAULT_COUNTERSIGN_METER, [field]: value },
        }, facilitator), /positive canonical int64/);
      }
    });
  }
  await assert.rejects(createPaymentGate({
    ...config, countersignMeter: { ...DEFAULT_COUNTERSIGN_METER, minTinybars: "10000001" },
  }, facilitator), /minimum must not exceed maximum/);
});

test("gate uses its configured rates and bounds without accepting later configuration mutations", async () => {
  const meter = { baseTinybars: "1", perKilobyteTinybars: "1024", perAdjustmentTinybars: "1", minTinybars: "5", maxTinybars: "500" };
  const gate = await createPaymentGate({ ...config, countersignMeter: meter }, facilitator);
  meter.maxTinybars = "999999";
  for (const [input, amount] of [["!", "5"], [transactionBytes("x".repeat(1000)), "500"]]) {
    const outcome = await gate.review(undefined, "/countersign", input);
    assert.ok(!outcome.paid);
    assert.equal(decodePaymentRequiredHeader(outcome.headers["PAYMENT-REQUIRED"]).accepts[0].amount, amount);
  }
  await assert.rejects(gate.review(undefined, "/countersign"), /requires transactionBase64/);
});

test("metered gate refuses underpayment and accepts exact payment through the real Hedera scheme", async () => {
  const payerKey = PrivateKey.generateED25519();
  const submitted: string[] = [];
  const scheme = new ExactHederaScheme({
    getAddresses: () => ["0.0.7162784"],
    async verifyPayerSignature({ transaction }) {
      return { ok: payerKey.publicKey.verifyTransaction(Transaction.fromBytes(Buffer.from(transaction, "base64"))) };
    },
    async preflightTransfer() { return { ok: true }; },
    async signAndSubmitTransaction(transaction) {
      submitted.push(transaction);
      return { transactionId: "0.0.7162784@1788509000.000000001" };
    },
  });
  const gate = await createPaymentGate(config, {
    ...facilitator,
    verify: (payload, requirements) => scheme.verify(payload, requirements),
    settle: (payload, requirements) => scheme.settle(payload, requirements),
  });
  const input = transactionBytes("authorization");
  const outcome = await gate.review(undefined, "/countersign", input);
  assert.ok(!outcome.paid);
  const required = decodePaymentRequiredHeader(outcome.headers["PAYMENT-REQUIRED"]);
  const requirements = required.accepts[0];
  const signer = createClientHederaSigner("0.0.8001", payerKey, { network: "hedera:testnet" });
  async function paymentHeader(accepted: PaymentRequirements, amount = accepted.amount) {
    return encodePaymentSignatureHeader({
      x402Version: 2, resource: required.resource, accepted,
      payload: { transaction: await signer.createPartiallySignedTransferTransaction({ ...accepted, amount }) },
    });
  }
  const underpaid = (BigInt(requirements.amount) - 1n).toString();
  assert.equal((await gate.review(await paymentHeader({ ...requirements, amount: underpaid }), "/countersign", input)).paid, false);
  assert.equal(submitted.length, 0);
  // A truthful accepted amount cannot disguise smaller actual HBAR transfers.
  assert.equal((await gate.review(await paymentHeader(requirements, underpaid), "/countersign", input)).paid, false);
  assert.equal(submitted.length, 0);
  const client = new x402Client().register("hedera:testnet", new ClientHederaScheme(signer));
  client.setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: config.priceTinybars }] });
  const httpClient = new x402HTTPClient(client);
  await assert.rejects(httpClient.createPaymentPayload(required));
  assert.equal(submitted.length, 0, "the caller's existing spending cap must remain effective");
  client.setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: DEFAULT_COUNTERSIGN_METER.maxTinybars }] });
  const exactPayload = await httpClient.createPaymentPayload(required);
  assert.deepEqual(exactPayload.accepted, requirements);
  const exactHeader = encodePaymentSignatureHeader(exactPayload);
  assert.equal((await gate.review(exactHeader, "/countersign", transactionBytes("authorization with more bytes"))).paid, false);
  assert.equal(submitted.length, 0);
  const paid = await gate.review(exactHeader, "/countersign", input);
  assert.ok(paid.paid);
  assert.equal(submitted.length, 1);
  assert.ok(paid.responseHeaders["PAYMENT-RESPONSE"]);
});
