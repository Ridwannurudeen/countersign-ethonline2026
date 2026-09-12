import assert from "node:assert/strict";
import test from "node:test";

import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
  x402HTTPClient,
} from "@x402/core/http";
import {
  AccountId,
  KeyList,
  PrivateKey,
  Transaction,
  TransactionId,
  TransferTransaction,
  type PublicKey,
} from "@hiero-ledger/sdk";
import {
  createClientHederaSigner,
  inspectHederaTransaction,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import {
  createPaymentGate,
  type PaymentGateConfig,
} from "../src/payment-gate.ts";

const operationalKey = PrivateKey.generateED25519().publicKey;
const ownerPrivateKey = PrivateKey.generateED25519();
const ownerKey = ownerPrivateKey.publicKey;
const agentPrivateKey = PrivateKey.generateED25519();
const agentKey = agentPrivateKey.publicKey;
const guardPrivateKey = PrivateKey.generateED25519();
// A payer holding none of the treasury authorization keys.
const unrelatedPrivateKey = PrivateKey.generateED25519();
const guardKey = guardPrivateKey.publicKey;
const paymentPayerKey = PrivateKey.generateED25519();
const paymentPayerAccountId = "0.0.8001";

const baseConfig: PaymentGateConfig = {
  resourceUrl: "https://guard.example/review",
  priceTinybars: "1000000",
  operationalAccount: {
    accountId: "0.0.9001",
    publicKey: operationalKey,
  },
  treasuryAuthorizations: [{
    accountId: "0.0.1001",
    ownerPublicKey: ownerKey,
    agentPublicKey: agentKey,
    guardPublicKey: guardKey,
  }],
};

class OfflineFacilitator implements FacilitatorClient {
  readonly settled: Array<{
    paymentPayload: PaymentPayload;
    paymentRequirements: PaymentRequirements;
  }> = [];
  verifyCalls = 0;
  private readonly settlement: SettleResponse;

  constructor(
    settlement: SettleResponse = {
      success: true,
      payer: "0.0.8001",
      transaction: "0.0.7162784@1788537600.000000001",
      network: "hedera:testnet",
    },
  ) {
    this.settlement = settlement;
  }

  async verify(): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    return { isValid: true, payer: "0.0.8001" };
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settled.push({ paymentPayload, paymentRequirements });
    return this.settlement;
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "hedera:testnet",
          extra: { feePayer: "0.0.7162784" },
        },
      ],
      extensions: [],
      signers: { "hedera:*": ["0.0.7162784"] },
    };
  }
}

async function paymentRequirements(
  facilitator: FacilitatorClient,
  config: PaymentGateConfig = baseConfig,
): Promise<PaymentRequirements> {
  const gate = await createPaymentGate(config, facilitator);
  const outcome = await gate.review();
  assert.equal(outcome.paid, false);
  if (outcome.paid) {
    throw new Error("expected an x402 payment requirement");
  }

  const encoded = outcome.headers["PAYMENT-REQUIRED"];
  assert.ok(encoded);
  const paymentRequired = decodePaymentRequiredHeader(encoded);
  assert.equal(paymentRequired.accepts.length, 1);
  return paymentRequired.accepts[0];
}

async function createPaymentSignatureHeader(
  facilitator: FacilitatorClient,
  payerAccountId: string,
  payerPrivateKey: PrivateKey,
): Promise<string> {
  const requirements = await paymentRequirements(facilitator);
  const payer = new x402Client()
    .register(
      "hedera:testnet",
      new ExactHederaScheme(
        createClientHederaSigner(payerAccountId, payerPrivateKey, {
          network: "hedera:testnet",
        }),
      ),
    )
    .setSpendControls({
      allowedAssets: [
        {
          network: "hedera:testnet",
          asset: "0.0.0",
          maxAmountPerPayment: baseConfig.priceTinybars,
        },
      ],
    });
  const paymentPayload = await new x402HTTPClient(payer).createPaymentPayload({
    x402Version: 2,
    resource: { url: baseConfig.resourceUrl },
    accepts: [requirements],
  });
  return encodePaymentSignatureHeader(paymentPayload);
}

async function createTokenPaymentSignatureHeader(
  facilitator: FacilitatorClient,
  senderAccountId: string,
  senderPrivateKey: PrivateKey,
): Promise<string> {
  const requirements = await paymentRequirements(facilitator);
  const transaction = await new TransferTransaction()
    .addTokenTransfer("0.0.7001", senderAccountId, -1n)
    .addTokenTransfer("0.0.7001", baseConfig.operationalAccount.accountId, 1n)
    .setTransactionId(TransactionId.generate("0.0.7162784"))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .freeze()
    .sign(senderPrivateKey);
  const inspected = inspectHederaTransaction(
    Buffer.from(transaction.toBytes()).toString("base64"),
  );
  assert.deepEqual(inspected.tokenTransfers["0.0.7001"], [
    { accountId: senderAccountId, amount: "-1" },
    { accountId: baseConfig.operationalAccount.accountId, amount: "1" },
  ]);
  assert.equal(senderPrivateKey.publicKey.verifyTransaction(transaction), true);
  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: baseConfig.resourceUrl },
    accepted: requirements,
    payload: {
      transaction: Buffer.from(transaction.toBytes()).toString("base64"),
    },
  };
  return encodePaymentSignatureHeader(paymentPayload);
}

test("payment gate quotes one HBAR review check before settlement", async () => {
  const facilitator = new OfflineFacilitator();
  const gate = await createPaymentGate(baseConfig, facilitator);

  const outcome = await gate.review();

  assert.equal(outcome.paid, false);
  if (outcome.paid) {
    throw new Error("expected an x402 payment requirement");
  }
  assert.equal(outcome.status, 402);
  assert.equal(outcome.headers["Cache-Control"], "no-store");

  const encoded = outcome.headers["PAYMENT-REQUIRED"];
  assert.ok(encoded);
  const paymentRequired = decodePaymentRequiredHeader(encoded);
  assert.deepEqual(paymentRequired, {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: "https://guard.example/review",
      description: "Countersign schedule review check",
      mimeType: "application/json",
      serviceName: "Countersign",
    },
    accepts: [
      {
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: "1000000",
        payTo: "0.0.9001",
        maxTimeoutSeconds: 300,
        extra: {
          paymentFlow: "upfront",
          feePayer: "0.0.7162784",
        },
      },
    ],
  });
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal(facilitator.settled.length, 0);
});

test("payment gate settles a separately signed HBAR payment against its quote", async () => {
  const facilitator = new OfflineFacilitator();
  const requirements = await paymentRequirements(facilitator);
  const gate = await createPaymentGate(baseConfig, facilitator);
  const paymentHeader = await createPaymentSignatureHeader(
    facilitator,
    paymentPayerAccountId,
    paymentPayerKey,
  );
  const paymentPayload = decodePaymentSignatureHeader(paymentHeader);
  assert.deepEqual(paymentPayload.accepted, requirements);
  assert.equal(requirements.asset, "0.0.0");
  const transaction = paymentPayload.payload.transaction;
  assert.equal(typeof transaction, "string");
  if (typeof transaction !== "string") assert.fail("expected transaction");
  const inspected = inspectHederaTransaction(transaction);
  assert.deepEqual(inspected.hbarTransfers, [
    { accountId: paymentPayerAccountId, amount: `-${requirements.amount}` },
    { accountId: requirements.payTo, amount: requirements.amount },
  ]);
  assert.deepEqual(inspected.tokenTransfers, {});
  assert.equal(
    paymentPayerKey.publicKey.verifyTransaction(
      Transaction.fromBytes(Buffer.from(transaction, "base64")),
    ),
    true,
  );

  const outcome = await gate.review(
    encodePaymentSignatureHeader(paymentPayload),
  );

  assert.equal(outcome.paid, true);
  if (!outcome.paid) {
    throw new Error("expected a settled review payment");
  }
  assert.equal(outcome.settlementId, "0.0.7162784@1788537600.000000001");
  assert.ok(outcome.responseHeaders["PAYMENT-RESPONSE"]);
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal(facilitator.settled.length, 1);
  assert.deepEqual(facilitator.settled[0], {
    paymentPayload,
    paymentRequirements: requirements,
  });
});

test("payment gate refuses an invalid payment header without settlement", async () => {
  const facilitator = new OfflineFacilitator();
  const gate = await createPaymentGate(baseConfig, facilitator);

  const outcome = await gate.review("not-base64!");

  assert.equal(outcome.paid, false);
  if (outcome.paid) {
    throw new Error("expected an x402 payment requirement");
  }
  assert.equal(outcome.status, 402);
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal(facilitator.settled.length, 0);
});

test("payment gate refuses a failed up-front settlement", async () => {
  const facilitator = new OfflineFacilitator({
    success: false,
    errorReason: "transaction_failed",
    transaction: "",
    network: "hedera:testnet",
  });
  const gate = await createPaymentGate(baseConfig, facilitator);
  // A real, decodable payment from an unrelated payer: the gate must let it reach the
  // facilitator, which then reports the settlement failure. An undecodable payload would
  // now be refused earlier, so it cannot exercise this path.
  const paymentHeader = await createPaymentSignatureHeader(
    facilitator,
    "0.0.8201",
    unrelatedPrivateKey,
  );

  const outcome = await gate.review(paymentHeader);

  assert.equal(outcome.paid, false);
  if (outcome.paid) {
    throw new Error("expected settlement refusal");
  }
  assert.equal(outcome.status, 402);
  assert.equal(facilitator.settled.length, 1);
});

// A sigPair may legitimately carry a pubKeyPrefix shorter than a full public key, which
// makes the SDK throw while decoding. If that threw its way past the treasury-identity
// rule, a caller could skip the rule entirely by trimming one length byte, and the guard
// would forward the payment for settlement believing no authorization key was involved.
test("INVARIANT: a payment the guard cannot decode never settles", async (t) => {
  for (const [name, transaction] of [
    ["not a transaction", "offline-partially-signed-transaction"],
    ["truncated bytes", Buffer.from([0x0a, 0x02, 0xff]).toString("base64")],
  ] as const) {
    await t.test(name, async () => {
      const facilitator = new OfflineFacilitator();
      const requirements = await paymentRequirements(facilitator);
      const gate = await createPaymentGate(baseConfig, facilitator);
      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction },
      };

      const outcome = await gate.review(encodePaymentSignatureHeader(payload));

      assert.equal(outcome.paid, false);
      assert.equal(facilitator.settled.length, 0, "undecodable payment must not settle");
    });
  }
});

test("payment gate refuses every treasury authorization signer before settlement", async (t) => {
  for (const [name, accountId, privateKey] of [
    ["owner", "0.0.8101", ownerPrivateKey],
    ["agent", "0.0.8102", agentPrivateKey],
    ["guard", "0.0.8103", guardPrivateKey],
  ] as const) {
    await t.test(name, async () => {
      const facilitator = new OfflineFacilitator();
      const paymentHeader = await createPaymentSignatureHeader(
        facilitator,
        accountId,
        privateKey,
      );
      const gate = await createPaymentGate(baseConfig, facilitator);

      const outcome = await gate.review(paymentHeader);

      assert.equal(outcome.paid, false);
      assert.equal(facilitator.verifyCalls, 0);
      assert.equal(facilitator.settled.length, 0);
    });
  }
});

test("payment gate refuses the treasury account as payer before settlement", async () => {
  const facilitator = new OfflineFacilitator();
  const paymentHeader = await createPaymentSignatureHeader(
    facilitator,
    baseConfig.treasuryAuthorizations[0].accountId,
    paymentPayerKey,
  );
  const gate = await createPaymentGate(baseConfig, facilitator);

  const outcome = await gate.review(paymentHeader);

  assert.equal(outcome.paid, false);
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal(facilitator.settled.length, 0);
});

test("invariant: the challenge exposes only the operational payment account", async () => {
  const requirements = await paymentRequirements(new OfflineFacilitator());
  const serialized = JSON.stringify(requirements);

  assert.equal(requirements.payTo, baseConfig.operationalAccount.accountId);
  assert.deepEqual(Object.keys(requirements).sort(), [
    "amount",
    "asset",
    "extra",
    "maxTimeoutSeconds",
    "network",
    "payTo",
    "scheme",
  ]);
  for (const authorizationKey of [ownerKey, agentKey, guardKey]) {
    assert.equal(serialized.includes(authorizationKey.toString()), false);
  }
  assert.equal(serialized.includes(operationalKey.toString()), false);
});

test("invariant: the decoded payment payload contains no treasury authorization identity", async () => {
  const facilitator = new OfflineFacilitator();
  const gate = await createPaymentGate(baseConfig, facilitator);
  const challenge = await gate.review();
  assert.equal(challenge.paid, false);
  if (challenge.paid) {
    throw new Error("expected an x402 payment requirement");
  }
  const encoded = challenge.headers["PAYMENT-REQUIRED"];
  assert.ok(encoded);
  const required = decodePaymentRequiredHeader(encoded);
  const payer = new x402Client()
    .register(
      "hedera:testnet",
      new ExactHederaScheme(
        createClientHederaSigner(paymentPayerAccountId, paymentPayerKey, {
          network: "hedera:testnet",
        }),
      ),
    )
    .setSpendControls({
      allowedAssets: [
        {
          network: "hedera:testnet",
          asset: "0.0.0",
          maxAmountPerPayment: baseConfig.priceTinybars,
        },
      ],
    });

  const paymentPayload = await new x402HTTPClient(payer).createPaymentPayload(
    required,
  );
  if (
    paymentPayload.payload === null ||
    typeof paymentPayload.payload !== "object" ||
    !("transaction" in paymentPayload.payload) ||
    typeof paymentPayload.payload.transaction !== "string"
  ) {
    throw new Error("payment payload must contain a Hedera transaction");
  }

  const inspected = inspectHederaTransaction(
    paymentPayload.payload.transaction,
  );
  const transaction = Transaction.fromBytes(
    Buffer.from(paymentPayload.payload.transaction, "base64"),
  );
  const signerKeys = transaction
    .getSignatures()
    .getFlatSignatureList()
    .flatMap((signatures) => [...signatures.keys()]);

  assert.equal(
    inspected.hbarTransfers.find((transfer) => BigInt(transfer.amount) < 0n)
      ?.accountId,
    paymentPayerAccountId,
  );
  for (const authorizationAccountId of [
    baseConfig.treasuryAuthorizations[0].accountId,
    "0.0.2001",
    "0.0.3001",
  ]) {
    assert.notEqual(inspected.transactionIdAccountId, authorizationAccountId);
  }
  assert.ok(signerKeys.length > 0);
  assert.equal(
    signerKeys.every((key) => key.equals(paymentPayerKey.publicKey)),
    true,
  );
  for (const authorizationKey of [ownerKey, agentKey, guardKey]) {
    assert.equal(signerKeys.some((key) => key.equals(authorizationKey)), false);
  }
});

test("payment gate refuses the treasury account as the payment account", async () => {
  const facilitator = new OfflineFacilitator();
  await assert.rejects(
    createPaymentGate(
      {
        ...baseConfig,
        operationalAccount: {
          ...baseConfig.operationalAccount,
          accountId: baseConfig.treasuryAuthorizations[0].accountId,
        },
      },
      facilitator,
    ),
    /operational payment account must differ from the treasury account/,
  );
});

test("payment gate refuses every treasury authorization key as the operational key", async (t) => {
  for (const [name, publicKey] of [
    ["owner", ownerKey],
    ["agent", agentKey],
    ["guard", guardKey],
  ] as const) {
    await t.test(name, async () => {
      await assert.rejects(
        createPaymentGate(
          {
            ...baseConfig,
            operationalAccount: {
              ...baseConfig.operationalAccount,
              publicKey,
            },
          },
          new OfflineFacilitator(),
        ),
        /operational payment key must be separate from treasury authorization keys/,
      );
    });
  }
});

test("payment gate requires a single operational key", async () => {
  await assert.rejects(
    createPaymentGate(
      {
        ...baseConfig,
        operationalAccount: {
          ...baseConfig.operationalAccount,
          publicKey: new KeyList([operationalKey]) as unknown as PublicKey,
        },
      },
      new OfflineFacilitator(),
    ),
    /operational payment key must be a single public key/,
  );
});

test("payment gate enforces the tinybar price limits", async (t) => {
  for (const [priceTinybars, message] of [
    ["0", /priceTinybars must be positive/],
    ["01", /priceTinybars must be a minimal unsigned decimal string/],
    ["9223372036854775808", /priceTinybars exceeds the Hedera int64 limit/],
  ] as const) {
    await t.test(priceTinybars, async () => {
      await assert.rejects(
        createPaymentGate(
          { ...baseConfig, priceTinybars },
          new OfflineFacilitator(),
        ),
        message,
      );
    });
  }
});

test("INVARIANT: a payment whose token sender is a treasury authorization identity must be refused before settlement", async (t) => {
  for (const [name, accountId, privateKey] of [
    ["owner", "0.0.8101", ownerPrivateKey],
    ["agent", "0.0.8102", agentPrivateKey],
    ["guard", "0.0.8103", guardPrivateKey],
  ] as const) {
    await t.test(name, async () => {
      const facilitator = new OfflineFacilitator();
      const paymentHeader = await createTokenPaymentSignatureHeader(
        facilitator,
        accountId,
        privateKey,
      );
      const gate = await createPaymentGate(baseConfig, facilitator);

      const outcome = await gate.review(paymentHeader);

      assert.equal(outcome.paid, false);
      assert.equal(facilitator.verifyCalls, 0);
      assert.equal(facilitator.settled.length, 0);
    });
  }
});

test("INVARIANT: a payment whose token sender is the treasury account must be refused before settlement", async () => {
  const facilitator = new OfflineFacilitator();
  const paymentHeader = await createTokenPaymentSignatureHeader(
    facilitator,
    baseConfig.treasuryAuthorizations[0].accountId,
    paymentPayerKey,
  );
  const gate = await createPaymentGate(baseConfig, facilitator);

  const outcome = await gate.review(paymentHeader);

  assert.equal(outcome.paid, false);
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal(facilitator.settled.length, 0);
});

test("INVARIANT: a separately keyed token sender reaches facilitator validation and preserves its refusal", async () => {
  const facilitator = new OfflineFacilitator({
    success: false,
    errorReason: "token payment does not satisfy the HBAR quote",
    transaction: "",
    network: "hedera:testnet",
  });
  const paymentHeader = await createTokenPaymentSignatureHeader(
    facilitator,
    paymentPayerAccountId,
    paymentPayerKey,
  );
  const gate = await createPaymentGate(baseConfig, facilitator);

  const outcome = await gate.review(paymentHeader);

  assert.equal(outcome.paid, false);
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal(facilitator.settled.length, 1);
  assert.deepEqual(
    facilitator.settled[0].paymentPayload,
    decodePaymentSignatureHeader(paymentHeader),
  );
  assert.equal(facilitator.settled[0].paymentRequirements.asset, "0.0.0");
});
