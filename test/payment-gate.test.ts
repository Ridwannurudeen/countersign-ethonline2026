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
  encodePaymentSignatureHeader,
  x402HTTPClient,
} from "@x402/core/http";
import {
  KeyList,
  PrivateKey,
  Transaction,
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
  treasuryAuthorization: {
    accountId: "0.0.1001",
    ownerPublicKey: ownerKey,
    agentPublicKey: agentKey,
    guardPublicKey: guardKey,
  },
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

test("payment gate settles up front and returns the settlement id", async () => {
  const facilitator = new OfflineFacilitator();
  const requirements = await paymentRequirements(facilitator);
  const gate = await createPaymentGate(baseConfig, facilitator);
  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: {
      url: baseConfig.resourceUrl,
    },
    accepted: requirements,
    payload: { transaction: "offline-partially-signed-transaction" },
  };

  const outcome = await gate.review(encodePaymentSignatureHeader(paymentPayload));

  assert.equal(outcome.paid, true);
  if (!outcome.paid) {
    throw new Error("expected a settled review payment");
  }
  assert.equal(
    outcome.settlementId,
    "0.0.7162784@1788537600.000000001",
  );
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
  const requirements = await paymentRequirements(facilitator);
  const gate = await createPaymentGate(baseConfig, facilitator);
  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: "offline-partially-signed-transaction" },
  };

  const outcome = await gate.review(encodePaymentSignatureHeader(paymentPayload));

  assert.equal(outcome.paid, false);
  if (outcome.paid) {
    throw new Error("expected settlement refusal");
  }
  assert.equal(outcome.status, 402);
  assert.equal(facilitator.settled.length, 1);
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
    baseConfig.treasuryAuthorization.accountId,
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
    baseConfig.treasuryAuthorization.accountId,
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
          accountId: baseConfig.treasuryAuthorization.accountId,
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
