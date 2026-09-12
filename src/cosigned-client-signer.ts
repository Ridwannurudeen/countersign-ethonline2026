import { proto } from "@hiero-ledger/proto";
import {
  AccountId,
  Hbar,
  type PrivateKey,
  type PublicKey,
  TokenId,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import type { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import {
  assertSupportedHederaNetwork,
  createHederaClient,
  isHbarAsset,
  type ClientHederaSigner,
  type HederaClientSignerConfig,
} from "@x402/hedera";

import { resolveGuard } from "../scripts/hosted-review.ts";
import type { MandateEnvelope } from "./mandate.ts";

export interface CosignedClientHederaSignerConfig extends HederaClientSignerConfig {
  readonly guardUaid: string;
  readonly guardOrigin: string;
  readonly guardPublicKey: PublicKey;
  readonly mandateEnvelope: MandateEnvelope;
  readonly guardPaymentClient: x402Client;
}

export class CountersignRefusal extends Error {
  readonly invariant: string;

  constructor(invariant: string) {
    super(`Countersign refused: ${invariant}`);
    this.name = "CountersignRefusal";
    this.invariant = invariant;
  }
}

function verifyCountersignedBytes(sent: string, returned: string, guardKey: PublicKey): void {
  const bytes = Buffer.from(returned, "base64");
  const original = proto.TransactionList.decode(Buffer.from(sent, "base64"));
  const received = proto.TransactionList.decode(bytes);
  if (received.transactionList.length !== original.transactionList.length) {
    throw new Error("countersigned transaction list changed");
  }
  for (const [index, transaction] of original.transactionList.entries()) {
    const before = proto.SignedTransaction.decode(transaction.signedTransactionBytes!);
    const after = proto.SignedTransaction.decode(received.transactionList[index].signedTransactionBytes!);
    if (!Buffer.from(before.bodyBytes).equals(after.bodyBytes)) {
      throw new Error("countersigned transaction body changed");
    }
    const pairs = after.sigMap?.sigPair ?? [];
    const guardPairs = pairs.filter((pair) => pair.pubKeyPrefix != null &&
      Buffer.from(guardKey.toBytesRaw()).equals(pair.pubKeyPrefix));
    const signature = guardPairs[0]?.[guardKey.type === "ED25519" ? "ed25519" : "ECDSASecp256k1"];
    if (guardPairs.length !== 1 || signature == null || !guardKey.verify(before.bodyBytes, signature)) {
      throw new Error("countersigned transaction must add a valid configured guard signature");
    }
    before.sigMap!.sigPair!.push(guardKey._toProtobufSignature(signature));
    transaction.signedTransactionBytes = proto.SignedTransaction.encode(before).finish();
  }
  if (bytes.toString("base64") !== returned ||
    !Buffer.from(proto.TransactionList.encode(original).finish()).equals(bytes)) {
    throw new Error("countersigned bytes must contain only the original transaction plus the guard signature");
  }
}

export function createCosignedClientHederaSigner(
  accountId: string,
  agentKey: PrivateKey,
  config: CosignedClientHederaSignerConfig,
): ClientHederaSigner {
  const network = config.network ?? "hedera:testnet";
  assertSupportedHederaNetwork(network);
  const treasury = AccountId.fromString(accountId);
  const httpPayer = new x402HTTPClient(config.guardPaymentClient);
  return {
    accountId: treasury.toString(),
    async createPartiallySignedTransferTransaction(requirements) {
      assertSupportedHederaNetwork(requirements.network);
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== "string") {
        throw new Error("feePayer is required in paymentRequirements.extra");
      }
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error("amount must be greater than zero");
      const payTo = AccountId.fromString(requirements.payTo);
      const transaction = new TransferTransaction();
      if (isHbarAsset(requirements.asset)) {
        transaction.addHbarTransfer(treasury, Hbar.fromTinybars((-amount).toString()));
        transaction.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
      } else {
        const token = TokenId.fromString(requirements.asset);
        transaction.addTokenTransfer(token, treasury, -amount);
        transaction.addTokenTransfer(token, payTo, amount);
      }
      transaction.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));
      transaction.setTransactionValidDuration(180);
      const client = createHederaClient(network, config.nodeUrl);
      let transactionBase64: string;
      try {
        transaction.freezeWith(client);
        await transaction.sign(agentKey);
        transactionBase64 = Buffer.from(transaction.toBytes()).toString("base64");
      } finally {
        client.close();
      }

      const resolution = await resolveGuard(config.guardUaid, config.guardOrigin);
      const services = resolution.document.service as Record<string, unknown>[];
      const endpoints = services.filter((service) => service.id === "countersign");
      if (endpoints.length !== 1 || endpoints[0].type !== "HTTP" ||
        endpoints[0].method !== "POST" || typeof endpoints[0].serviceEndpoint !== "string") {
        throw new Error("agent card must contain exactly one HTTP POST countersign service");
      }
      const endpoint = new URL(endpoints[0].serviceEndpoint);
      if (endpoint.origin !== new URL(config.guardOrigin).origin ||
        endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "") {
        throw new Error("countersign endpoint must have the configured guard origin without credentials or a fragment");
      }
      const body = JSON.stringify({
        tenantId: config.mandateEnvelope.mandate.tenantId,
        mandateEnvelope: config.mandateEnvelope,
        transactionBase64,
      });
      const headers = { accept: "application/json", "content-type": "application/json" };
      const challenge = await fetch(endpoint, { method: "POST", redirect: "error", headers, body });
      if (challenge.status !== 402) {
        throw new Error(`guard did not return the required 402 challenge: HTTP ${challenge.status}`);
      }
      const paymentRequired = httpPayer.getPaymentRequiredResponse(
        (name) => challenge.headers.get(name), await challenge.json(),
      );
      const payment = await httpPayer.createPaymentPayload(paymentRequired);
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", body,
        headers: { ...headers, ...httpPayer.encodePaymentSignatureHeader(payment) },
      });
      if (!response.ok) throw new Error(`paid countersign request failed with HTTP ${response.status}`);
      const settlement = httpPayer.getPaymentSettleResponse((name) => response.headers.get(name));
      if (!settlement.success) throw new Error("guard payment settlement failed");
      const result: unknown = await response.json();
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("invalid countersign response");
      }
      if ("outcome" in result && result.outcome === "refused" &&
        "invariant" in result && typeof result.invariant === "string" && result.invariant !== "") {
        throw new CountersignRefusal(result.invariant);
      }
      if (!("outcome" in result) || result.outcome !== "approved" ||
        !("transactionBase64" in result) || typeof result.transactionBase64 !== "string") {
        throw new Error("invalid countersign response");
      }
      verifyCountersignedBytes(transactionBase64, result.transactionBase64, config.guardPublicKey);
      return result.transactionBase64;
    },
  };
}
