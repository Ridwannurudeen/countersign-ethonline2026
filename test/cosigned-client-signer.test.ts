import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { proto } from "@hiero-ledger/proto";
import { PrivateKey, Transaction } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createClientHederaSigner, inspectHederaTransaction } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import { createCosignedClientHederaSigner, CountersignRefusal } from "../src/cosigned-client-signer.ts";
import { canonicalMandateBytes, type MandateEnvelope } from "../src/mandate.ts";
import { countersignTransfer, validateCountersignTransfer } from "../src/countersign-transfer.ts";

const agent = PrivateKey.generateED25519();
const guard = PrivateKey.generateED25519();
const owner = PrivateKey.generateED25519();
const caller = PrivateKey.generateED25519();
const treasury = "0.0.1001";
const uaid = "uaid:aid:guard;nativeId=hedera:testnet:0.0.3001";
const origin = "https://guard.example";
const endpoint = `${origin}/countersign`;
const card = {
  uaid,
  url: `${origin}/review`,
  service: [
    { id: "review", type: "HTTP", method: "POST", serviceEndpoint: `${origin}/review` },
    { id: "countersign", type: "HTTP", method: "POST", serviceEndpoint: endpoint },
  ],
};
const envelope: MandateEnvelope = {
  mandate: {
    tenantId: "treasury-1", nonce: "19", treasuryAccountId: treasury,
    recipientAllowlist: ["0.0.1002"], maxAmountTinybars: "100",
    validFromEpochSeconds: "1", expiresAtEpochSeconds: "9999999999",
  },
  signature: "",
};
envelope.signature = Buffer.from(owner.sign(canonicalMandateBytes(envelope.mandate))).toString("base64url");
const requirements: PaymentRequirements = {
  scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: "100",
  payTo: "0.0.1002", maxTimeoutSeconds: 180, extra: { feePayer: "0.0.9001" },
};
const guardQuote = { ...requirements, amount: "10", payTo: "0.0.3001" };
const challenge: PaymentRequired = {
  x402Version: 2, resource: { url: endpoint, description: "Authorization", mimeType: "application/json" },
  accepts: [guardQuote],
};

function signer() {
  const guardPaymentClient = new x402Client().register("hedera:testnet", new ExactHederaScheme(
    createClientHederaSigner("0.0.8001", caller, { nodeUrl: "127.0.0.1:50211" }),
  )).setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: "10" }] });
  return createCosignedClientHederaSigner(treasury, agent, {
    nodeUrl: "127.0.0.1:50211", guardUaid: uaid, guardOrigin: origin,
    guardPublicKey: guard.publicKey, mandateEnvelope: envelope, guardPaymentClient,
  });
}

function signedList(bytes: string) {
  return proto.TransactionList.decode(Buffer.from(bytes, "base64"));
}

function rewrite(bytes: string, edit: (signed: proto.SignedTransaction) => void) {
  const list = signedList(bytes);
  for (const transaction of list.transactionList) {
    const signed = proto.SignedTransaction.decode(transaction.signedTransactionBytes!);
    edit(signed);
    transaction.signedTransactionBytes = proto.SignedTransaction.encode(signed).finish();
  }
  return Buffer.from(proto.TransactionList.encode(list).finish()).toString("base64");
}

function serveGuard(
  t: TestContext,
  verdict: (bytes: string) => Promise<unknown> = async (bytes) => ({
    outcome: "approved", transactionBase64: Buffer.from((await Transaction.fromBytes(Buffer.from(bytes, "base64")).sign(guard)).toBytes()).toString("base64"),
  }),
  document: unknown = card,
  quote: PaymentRequired = challenge,
  settlementSuccess = true,
) {
  const requests: string[] = [];
  const payments: string[] = [];
  let sent = "";
  let requestBody = "";
  t.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit) => {
    requests.push(String(url));
    assert.equal(options.redirect, "error");
    if (String(url) === `${origin}/.well-known/agent.json`) return Response.json(document);
    assert.equal(String(url), endpoint);
    assert.equal(options.method, "POST");
    const body = JSON.parse(String(options.body)) as { tenantId: string; mandateEnvelope: MandateEnvelope; transactionBase64: string };
    assert.deepEqual(Object.keys(body).sort(), ["mandateEnvelope", "tenantId", "transactionBase64"]);
    assert.equal(body.tenantId, envelope.mandate.tenantId);
    assert.deepEqual(body.mandateEnvelope, envelope);
    const payment = new Headers(options.headers).get("PAYMENT-SIGNATURE");
    if (payment === null) {
      sent = body.transactionBase64;
      requestBody = String(options.body);
      assert.ok(agent.publicKey.verifyTransaction(Transaction.fromBytes(Buffer.from(sent, "base64"))));
      return Response.json(quote, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(quote) } });
    }
    assert.equal(String(options.body), requestBody);
    const payload = decodePaymentSignatureHeader(payment);
    assert.deepEqual(payload.accepted, guardQuote);
    const transfer = payload.payload.transaction;
    assert.equal(typeof transfer, "string");
    assert.ok(caller.publicKey.verifyTransaction(Transaction.fromBytes(Buffer.from(transfer as string, "base64"))));
    assert.deepEqual(inspectHederaTransaction(transfer as string).hbarTransfers, [
      { accountId: "0.0.3001", amount: "10" }, { accountId: "0.0.8001", amount: "-10" },
    ]);
    payments.push(payment);
    return Response.json(await verdict(sent), { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({
      success: settlementSuccess, transaction: "0.0.9001@1788509000.000000001", network: "hedera:testnet",
    }) } });
  });
  return { requests, payments, sent: () => sent };
}

test("drop-in signer pays the guard and returns the treasury HBAR transfer with both signatures", async (t) => {
  const http = serveGuard(t);
  const cosigner = signer();
  assert.equal(cosigner.accountId, treasury);
  const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(cosigner))
    .setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: "100" }] });
  const payload = await client.createPaymentPayload({ ...challenge, accepts: [requirements] });
  const bytes = payload.payload.transaction;
  assert.equal(typeof bytes, "string");
  const tx = Transaction.fromBytes(Buffer.from(bytes as string, "base64"));
  assert.ok(agent.publicKey.verifyTransaction(tx));
  assert.ok(guard.publicKey.verifyTransaction(tx));
  assert.equal(tx.transactionId?.accountId?.toString(), requirements.extra.feePayer);
  assert.deepEqual(inspectHederaTransaction(bytes as string).hbarTransfers, [
    { accountId: treasury, amount: "-100" }, { accountId: requirements.payTo, amount: "100" },
  ]);
  assert.deepEqual(http.requests, [`${origin}/.well-known/agent.json`, endpoint, endpoint]);
  assert.equal(http.payments.length, 1);
});

test("explicit transaction validity is 180 seconds in the frozen agent-signed bytes", async (t) => {
  const http = serveGuard(t);
  await signer().createPartiallySignedTransferTransaction(requirements);
  for (const transaction of signedList(http.sent()).transactionList) {
    const signed = proto.SignedTransaction.decode(transaction.signedTransactionBytes!);
    assert.equal(proto.TransactionBody.decode(signed.bodyBytes).transactionValidDuration?.seconds?.toString(), "180");
  }
});

test("refuses returned bytes whose body differs from what was sent, even with valid signatures", async (t) => {
  const http = serveGuard(t, async (bytes) => ({ outcome: "approved", transactionBase64: rewrite(bytes, (signed) => {
    const body = proto.TransactionBody.decode(signed.bodyBytes);
    body.memo = "changed by remote guard";
    signed.bodyBytes = proto.TransactionBody.encode(body).finish();
    signed.sigMap = { sigPair: [agent, guard].map((key) => key.publicKey._toProtobufSignature(key.sign(signed.bodyBytes))) };
  }) }));
  await assert.rejects(signer().createPartiallySignedTransferTransaction(requirements), /body changed/);
  assert.equal(http.payments.length, 1);
});

test("paid refusal exposes the deciding invariant and prevents a seller payment payload", async (t) => {
  const invariant = "recipient is on the mandate allowlist";
  const http = serveGuard(t, async () => ({ outcome: "refused", invariant }));
  const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer()))
    .setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: "100" }] });
  await assert.rejects(client.createPaymentPayload({ ...challenge, accepts: [requirements] }), (error: unknown) => {
    assert.ok(error instanceof CountersignRefusal);
    assert.equal(error.invariant, invariant);
    assert.ok(error.message.includes(invariant));
    return true;
  });
  assert.equal(http.payments.length, 1);
  assert.ok(http.requests.every((url) => url.startsWith(origin)));
});

test("constructs the requested token transfer without making client-side policy decisions", async (t) => {
  const http = serveGuard(t, async () => ({ outcome: "refused", invariant: "HTS custom-fee state is verified as empty and immutable" }));
  await assert.rejects(signer().createPartiallySignedTransferTransaction({ ...requirements, asset: "0.0.456" }), CountersignRefusal);
  const tx = inspectHederaTransaction(http.sent());
  assert.deepEqual(tx.hbarTransfers, []);
  assert.deepEqual(tx.tokenTransfers, { "0.0.456": [
    { accountId: treasury, amount: "-100" }, { accountId: requirements.payTo, amount: "100" },
  ] });
});

test("refuses a mismatched UAID before paying the guard", async (t) => {
  const http = serveGuard(t, undefined, { ...card, uaid: "uaid:aid:different;nativeId=hedera:testnet:0.0.3002" });
  await assert.rejects(signer().createPartiallySignedTransferTransaction(requirements), /UAID does not match/);
  assert.equal(http.payments.length, 0);
  assert.deepEqual(http.requests, [`${origin}/.well-known/agent.json`]);
});

test("guard payment obeys caller spend controls before the paid request", async (t) => {
  const http = serveGuard(t, undefined, card, { ...challenge, accepts: [{ ...guardQuote, amount: "11" }] });
  await assert.rejects(signer().createPartiallySignedTransferTransaction(requirements));
  assert.equal(http.payments.length, 0);
  assert.equal(http.requests.length, 2);
});

test("withholds approved bytes when guard payment settlement failed", async (t) => {
  serveGuard(t, undefined, card, challenge, false);
  await assert.rejects(signer().createPartiallySignedTransferTransaction(requirements), /settlement failed/);
});

test("accepts the unchanged guard core's approval when the quoted fee payer is the treasury", async (t) => {
  serveGuard(t, async (bytes) => {
    const approval = validateCountersignTransfer(bytes, envelope, {
      expectedAgentAccountId: "0.0.2001", treasuryAccountId: treasury,
      ownerPublicKey: owner.publicKey, agentPublicKey: agent.publicKey, guardPublicKey: guard.publicKey,
      nowEpochSeconds: Math.floor(Date.now() / 1000).toString(), protocolMaxFeeTinybars: "100000000",
    });
    assert.ok(approval.approved, JSON.stringify(approval));
    return { outcome: "approved", transactionBase64: countersignTransfer(approval, guard) };
  });
  await signer().createPartiallySignedTransferTransaction({ ...requirements, extra: { feePayer: treasury } });
});

test("surfaces the current guard's treasury transaction-ID policy for a distinct stock fee payer", async (t) => {
  const http = serveGuard(t, async (bytes) => {
    const outcome = validateCountersignTransfer(bytes, envelope, {
      expectedAgentAccountId: "0.0.2001", treasuryAccountId: treasury,
      ownerPublicKey: owner.publicKey, agentPublicKey: agent.publicKey, guardPublicKey: guard.publicKey,
      nowEpochSeconds: Math.floor(Date.now() / 1000).toString(), protocolMaxFeeTinybars: "100000000",
    });
    assert.equal(outcome.approved, false);
    assert.ok(!outcome.approved);
    return { outcome: "refused", invariant: outcome.invariant };
  });
  await assert.rejects(signer().createPartiallySignedTransferTransaction(requirements),
    /transaction ID is an ordinary treasury-paid transaction/);
  assert.equal(http.payments.length, 1);
});

test("approval must add only the configured guard signature and preserve every node variant", async (t) => {
  const other = PrivateKey.generateED25519();
  const edits: Record<string, (bytes: string) => string> = {
    "missing guard": (bytes) => bytes,
    "different guard": (bytes) => rewrite(bytes, (signed) => {
      signed.sigMap!.sigPair!.push(other.publicKey._toProtobufSignature(other.sign(signed.bodyBytes)));
    }),
    "invalid guard signature": (bytes) => rewrite(bytes, (signed) => {
      signed.sigMap!.sigPair!.push(guard.publicKey._toProtobufSignature(new Uint8Array(64)));
    }),
    "missing agent": (bytes) => rewrite(bytes, (signed) => {
      signed.sigMap = { sigPair: [guard.publicKey._toProtobufSignature(guard.sign(signed.bodyBytes))] };
    }),
    "extra signer": (bytes) => rewrite(bytes, (signed) => {
      for (const key of [guard, other]) signed.sigMap!.sigPair!.push(key.publicKey._toProtobufSignature(key.sign(signed.bodyBytes)));
    }),
    "duplicate guard": (bytes) => rewrite(bytes, (signed) => {
      const pair = guard.publicKey._toProtobufSignature(guard.sign(signed.bodyBytes));
      signed.sigMap!.sigPair!.push(pair, pair);
    }),
    "missing node": () => Buffer.from(proto.TransactionList.encode({ transactionList: [] }).finish()).toString("base64"),
    "extra node": (bytes) => {
      const list = signedList(bytes);
      list.transactionList.push(list.transactionList[0]);
      return Buffer.from(proto.TransactionList.encode(list).finish()).toString("base64");
    },
    "unreviewed wrapper field": (bytes) => {
      const list = signedList(rewrite(bytes, (signed) => {
        signed.sigMap!.sigPair!.push(guard.publicKey._toProtobufSignature(guard.sign(signed.bodyBytes)));
      }));
      list.transactionList[0].bodyBytes = new Uint8Array([1]);
      return Buffer.from(proto.TransactionList.encode(list).finish()).toString("base64");
    },
  };
  for (const [name, edit] of Object.entries(edits)) {
    await t.test(name, async (t) => {
      serveGuard(t, async (bytes) => ({ outcome: "approved", transactionBase64: edit(bytes) }));
      await assert.rejects(signer().createPartiallySignedTransferTransaction(requirements));
    });
  }
});

test("requires an unambiguous same-origin countersign service in the resolved card", async (t) => {
  for (const [name, service] of [
    ["missing", card.service.slice(0, 1)],
    ["duplicate", [...card.service, card.service[1]]],
    ["cross-origin", [card.service[0], { ...card.service[1], serviceEndpoint: "https://other.example/countersign" }]],
    ["wrong method", [card.service[0], { ...card.service[1], method: "GET" }]],
  ] as const) {
    await t.test(name, async (t) => {
      const http = serveGuard(t, undefined, { ...card, service });
      await assert.rejects(signer().createPartiallySignedTransferTransaction(requirements), /countersign/);
      assert.equal(http.requests.length, 1);
    });
  }
});
