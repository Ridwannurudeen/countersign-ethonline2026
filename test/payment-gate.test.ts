import assert from "node:assert/strict";
import test from "node:test";

import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { KeyList, PrivateKey, type PublicKey } from "@hiero-ledger/sdk";

import {
  createPaymentGate,
  type PaymentGateConfig,
} from "../src/payment-gate.ts";

const operationalKey = PrivateKey.generateED25519().publicKey;
const ownerKey = PrivateKey.generateED25519().publicKey;
const agentKey = PrivateKey.generateED25519().publicKey;
const guardKey = PrivateKey.generateED25519().publicKey;

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
