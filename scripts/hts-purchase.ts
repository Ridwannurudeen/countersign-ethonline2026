import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { proto } from "@hiero-ledger/proto";
import {
  Client, Hbar, PrivateKey, PublicKey, TokenAssociateTransaction,
  TokenCreateTransaction, TokenType, Transaction, TransferTransaction,
} from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { createClientHederaSigner, inspectHederaTransaction } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import { CountersignRefusal, createCosignedClientHederaSigner } from "../src/cosigned-client-signer.ts";
import { canonicalMandateBytes, parseMandateEnvelope, type Mandate } from "../src/mandate.ts";
import { assertMirrorSettlement, transactionMirrorUrl } from "./guarded-purchase.ts";
import { resolveGuard } from "./hosted-review.ts";
import { DEFAULT_COUNTERSIGN_METER } from "../src/payment-meter.ts";

const NETWORK = "hedera:testnet";
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const SUPPLY_UNITS = 1000;
const TRANSFER_UNITS = "10";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

async function mirrorJson(url: string): Promise<unknown> {
  let response = await fetch(url);
  for (let attempt = 0; response.status === 404 && attempt < 20; attempt += 1) {
    await sleep(1500);
    response = await fetch(url);
  }
  assert.equal(response.status, 200, `mirror lookup: ${url}`);
  const body: unknown = await response.json();
  console.log(`${url}\n${JSON.stringify(body)}`);
  return body;
}

interface MirrorTokenTransaction {
  transaction_id: string;
  result: string;
  token_transfers: { token_id: string; account: string; amount: number }[];
  assessed_custom_fees?: unknown[];
}

export function assertMirrorTokenTransfer(
  data: { transactions: MirrorTokenTransaction[] }, id: string,
  token: string, treasury: string, recipient: string, amount: string,
): void {
  assert.ok(Array.isArray(data.transactions), "mirror transactions must be an array");
  const mirrorId = transactionMirrorUrl(id).split("/").at(-1);
  const matches = data.transactions.filter((tx) => tx.transaction_id === mirrorId && tx.result === "SUCCESS");
  assert.equal(matches.length, 1, "exactly one matching SUCCESS token transfer must exist");
  const transaction = matches[0];
  if (transaction.assessed_custom_fees !== undefined) {
    assert.deepEqual(transaction.assessed_custom_fees, [], "no custom fees may be assessed");
  }
  assert.ok(Array.isArray(transaction.token_transfers), "token adjustments must exist");
  assert.equal(transaction.token_transfers.length, 2, "only the mandated token debit and credit may exist");
  for (const transfer of transaction.token_transfers) {
    assert.equal(transfer.token_id, token);
    assert.ok(Number.isSafeInteger(transfer.amount));
  }
  const debit = transaction.token_transfers.filter((transfer) => transfer.account === treasury);
  const credit = transaction.token_transfers.filter((transfer) => transfer.account === recipient);
  assert.equal(debit.length, 1);
  assert.equal(credit.length, 1);
  assert.equal(BigInt(debit[0].amount), -BigInt(amount));
  assert.equal(BigInt(credit[0].amount), BigInt(amount));
}

export async function submit(transaction: Transaction, client: Client, label: string) {
  if (!transaction.isFrozen()) transaction.freezeWith(client);
  const id = transaction.transactionId!.toString();
  console.log(`${label} transaction ID (before submission): ${id}\n${transactionMirrorUrl(id)}`);
  const response = await transaction.execute(client);
  const receipt = await response.getReceipt(client);
  assert.equal(receipt.status.toString(), "SUCCESS");
  console.log(`${label} receipt: ${receipt.status.toString()}`);
  return { id, receipt };
}

async function main(): Promise<void> {
  console.log("Operator-run Hedera testnet authorization demonstration. HTS in the guarded transfer path; x402 review settlement stays HBAR.");
  const origin = required("COUNTERSIGN_GUARD_ORIGIN");
  assert.equal(origin, "https://countersign.gudman.xyz");
  const uaid = required("COUNTERSIGN_GUARD_UAID");
  const resolution = await resolveGuard(uaid, origin);
  const services = resolution.document.service as Record<string, unknown>[];
  const endpoints = services.filter((service) => service.id === "countersign");
  assert.equal(endpoints.length, 1);
  const endpoint = endpoints[0].serviceEndpoint;
  assert.equal(typeof endpoint, "string");
  assert.equal(endpoint, `${origin}/countersign`);
  const guardResponse = await fetch(new URL("/guard", origin));
  assert.equal(guardResponse.status, 200);
  const guard = await guardResponse.json() as { guardIdentifier: string; guardPublicKey: string };
  assert.equal(guard.guardIdentifier, uaid);
  assert.equal(resolution.document.guardPublicKey, guard.guardPublicKey);
  const guardKey = PublicKey.fromString(guard.guardPublicKey);

  const operator = required("HEDERA_OPERATOR_ACCOUNT_ID");
  const operatorKey = PrivateKey.fromStringDer(required("HEDERA_OPERATOR_PRIVATE_KEY"));
  const treasury = required("COUNTERSIGN_TREASURY_ACCOUNT_ID");
  const owner = PrivateKey.fromStringDer(required("COUNTERSIGN_OWNER_PRIVATE_KEY"));
  const agent = PrivateKey.fromStringDer(required("COUNTERSIGN_AGENT_PRIVATE_KEY"));
  const caller = required("COUNTERSIGN_PAYER_ACCOUNT_ID");
  const callerKey = PrivateKey.fromStringDer(required("COUNTERSIGN_PAYER_PRIVATE_KEY"));
  const recipient = required("COUNTERSIGN_ALLOWED_RECIPIENT_ACCOUNT_ID");
  const reviewRecipient = required("COUNTERSIGN_FEE_ACCOUNT_ID");
  assert.equal(recipient, operator, "hosted recipient must be the configured operator/token treasury");
  assert.equal(new Set([treasury, caller, recipient, reviewRecipient]).size, 4);
  for (const [role, id] of [["operator and allowed recipient", operator], ["guarded treasury", treasury],
    ["review payer and out-of-policy recipient", caller], ["HBAR review fee recipient", reviewRecipient]]) {
    console.log(`Reusing ${role}: ${id}\n${MIRROR}/accounts/${id}?transactions=false`);
  }
  const account = await mirrorJson(`${MIRROR}/accounts/${treasury}?transactions=false`) as {
    account: string; deleted: boolean; key: { _type: string; key: string };
  };
  assert.equal(account.account, treasury);
  assert.equal(account.deleted, false);
  assert.equal(account.key._type, "ProtobufEncoded");
  const expectedKey = proto.Key.encode({ thresholdKey: { threshold: 1, keys: { keys: [
    { ed25519: owner.publicKey.toBytesRaw() },
    { thresholdKey: { threshold: 2, keys: { keys: [
      { ed25519: agent.publicKey.toBytesRaw() }, { ed25519: guardKey.toBytesRaw() },
    ] } } },
  ] } } }).finish();
  assert.equal(account.key.key, Buffer.from(expectedKey).toString("hex"), "treasury keys must match owner, agent and live guard");
  console.log("Verified existing treasury authorization: 1-of[owner, 2-of[agent, guard]].");

  const client = Client.forTestnet().setOperator(operator, operatorKey);
  try {
    let token = process.argv[2];
    if (token === undefined) {
      const creation = new TokenCreateTransaction()
        .setTokenName("Countersign authorization test")
        .setTokenSymbol("CSAUTH")
        .setTokenType(TokenType.FungibleCommon)
        .setDecimals(0)
        .setInitialSupply(SUPPLY_UNITS)
        .setTreasuryAccountId(operator)
        .setCustomFees([])
        .setMaxTransactionFee(new Hbar(20));
      assert.equal(creation.feeScheduleKey, null);
      const created = await submit(creation, client, "Token creation");
      assert.ok(created.receipt.tokenId);
      token = created.receipt.tokenId.toString();
      console.log(`Created HTS token: ${token}\n${MIRROR}/tokens/${token}`);
      await mirrorJson(transactionMirrorUrl(created.id));
    } else {
      assert.match(token, /^0\.0\.[1-9][0-9]*$/);
      console.log(`Resuming after token creation, before treasury association: ${token}\n${MIRROR}/tokens/${token}`);
    }
    const tokenInfo = await mirrorJson(`${MIRROR}/tokens/${token}`) as {
      token_id: string; type: string; treasury_account_id: string; fee_schedule_key: unknown;
      custom_fees: { fixed_fees?: unknown[]; fractional_fees?: unknown[]; royalty_fees?: unknown[] };
    };
    assert.equal(tokenInfo.token_id, token);
    assert.equal(tokenInfo.type, "FUNGIBLE_COMMON");
    assert.equal(tokenInfo.treasury_account_id, recipient);
    assert.equal(tokenInfo.fee_schedule_key, null);
    for (const fees of [tokenInfo.custom_fees.fixed_fees, tokenInfo.custom_fees.fractional_fees, tokenInfo.custom_fees.royalty_fees]) {
      assert.ok(fees === undefined || (Array.isArray(fees) && fees.length === 0));
    }
    console.log("Token state verified: fungible, no custom fees, no fee schedule key.");

    const association = await new TokenAssociateTransaction().setAccountId(treasury)
      .setTokenIds([token]).freezeWith(client).sign(owner);
    const associated = await submit(association, client, "Owner-authorized guarded treasury association");
    await mirrorJson(transactionMirrorUrl(associated.id));
    const funded = await submit(new TransferTransaction()
      .addTokenTransfer(token, operator, -SUPPLY_UNITS)
      .addTokenTransfer(token, treasury, SUPPLY_UNITS), client, "Initial HTS supply to guarded treasury");
    assertMirrorTokenTransfer(await mirrorJson(transactionMirrorUrl(funded.id)) as { transactions: MirrorTokenTransaction[] },
      funded.id, token, operator, treasury, SUPPLY_UNITS.toString());
    for (const id of [treasury, recipient]) {
      const associations = await mirrorJson(`${MIRROR}/accounts/${id}/tokens?token.id=${token}`) as {
        tokens: { token_id: string; balance: number }[];
      };
      assert.ok(associations.tokens.some((entry) => entry.token_id === token));
    }
    console.log("Both token associations verified; allowed recipient was associated by token creation as token treasury.");

    let quotedReviewTinybars = DEFAULT_COUNTERSIGN_METER.minTinybars;
    const guardPaymentClient = new x402Client().register(NETWORK, new ExactHederaScheme(
      createClientHederaSigner(caller, callerKey, { network: NETWORK }),
    )).setSpendControls({ allowedAssets: [{ network: NETWORK, asset: "0.0.0", maxAmountPerPayment: DEFAULT_COUNTERSIGN_METER.maxTinybars }] })
      .onBeforePaymentCreation(async ({ selectedRequirements: quote }) => {
        assert.equal(quote.payTo, reviewRecipient);
        assert.ok(BigInt(quote.amount) >= BigInt(DEFAULT_COUNTERSIGN_METER.minTinybars));
        assert.ok(BigInt(quote.amount) <= BigInt(DEFAULT_COUNTERSIGN_METER.maxTinybars));
        quotedReviewTinybars = quote.amount;
        assert.equal(quote.network, NETWORK);
        assert.equal(quote.asset, "0.0.0");
        assert.equal(typeof quote.extra?.feePayer, "string");
        assert.notEqual(quote.extra.feePayer, caller);
        console.log(`x402 review quote (HBAR only): ${JSON.stringify(quote)}`);
      });
    const httpPayer = new x402HTTPClient(guardPaymentClient);
    for (const [label, destination] of [["in-policy", recipient], ["out-of-policy", caller]]) {
      console.log(`\nHTS authorization case: ${label}`);
      const now = Math.floor(Date.now() / 1000);
      const mandate: Mandate = {
        schemaVersion: "2", asset: { kind: "hts", tokenId: token },
        tenantId: required("COUNTERSIGN_TENANT_ID"), nonce: Date.now().toString(),
        treasuryAccountId: treasury, recipientAllowlist: [recipient], maxAmountTinybars: TRANSFER_UNITS,
        validFromEpochSeconds: (now - 60).toString(), expiresAtEpochSeconds: (now + 600).toString(),
      };
      const mandateEnvelope = parseMandateEnvelope({ mandate,
        signature: Buffer.from(owner.sign(canonicalMandateBytes(mandate))).toString("base64url") });
      console.log(`Owner-signed HTS mandate (maxAmountTinybars is the schema's raw token-unit cap): ${JSON.stringify(mandate)}`);
      const signer = createCosignedClientHederaSigner(treasury, agent, {
        network: NETWORK, guardOrigin: origin, guardUaid: uaid, guardPublicKey: guardKey,
        mandateEnvelope, guardPaymentClient,
      });
      let proposalId: string | undefined;
      let expiry = 0;
      let settlementId: string | undefined;
      let outcome: string | undefined;
      let returnedBytes = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const target = input instanceof Request ? input.url : String(input);
        if (target === endpoint && typeof init?.body === "string") {
          const body = JSON.parse(init.body) as { transactionBase64: string };
          proposalId = inspectHederaTransaction(body.transactionBase64).transactionId;
          const list = proto.TransactionList.decode(Buffer.from(body.transactionBase64, "base64"));
          const signed = proto.SignedTransaction.decode(list.transactionList[0].signedTransactionBytes!);
          const transaction = proto.TransactionBody.decode(signed.bodyBytes);
          const start = transaction.transactionID!.transactionValidStart!;
          expiry = Number(start.seconds!.toString()) * 1000 + Math.ceil((start.nanos ?? 0) / 1_000_000) +
            Number(transaction.transactionValidDuration!.seconds!.toString()) * 1000;
          console.log(`HTS proposal ID (not yet submitted): ${proposalId}\n${transactionMirrorUrl(proposalId)}`);
        }
        const response = await originalFetch(input, init);
        if (target === endpoint) {
          const paid = new Headers(init?.headers).has("PAYMENT-SIGNATURE");
          console.log(`Live /countersign HTTP ${response.status}; HBAR-paid request: ${paid}`);
          if (paid) {
            const settlement = httpPayer.getPaymentSettleResponse((name) => response.headers.get(name));
            console.log(`x402 HBAR review settlement: ${JSON.stringify(settlement)}`);
            assert.equal(settlement.success, true);
            settlementId = settlement.transaction;
            console.log(transactionMirrorUrl(settlementId));
            const body = await response.clone().json() as {
              outcome: string; invariant?: string; transactionId: string; settlementId: string;
              mirrorNodeUrl: string; transactionBase64?: string;
            };
            const { transactionBase64, ...receipt } = body;
            console.log(`Live guard authorization response: ${JSON.stringify(receipt)}`);
            assert.equal(response.status, 200);
            assert.equal(body.transactionId, proposalId);
            assert.equal(body.settlementId, settlementId);
            outcome = body.outcome;
            returnedBytes = transactionBase64 !== undefined;
            if (body.outcome === "refused") assert.equal(returnedBytes, false, "refusal must withhold countersigned bytes");
          }
        }
        return response;
      };
      let approvedBytes: string | undefined;
      try {
        approvedBytes = await signer.createPartiallySignedTransferTransaction({
          scheme: "exact", network: NETWORK, asset: token, amount: TRANSFER_UNITS,
          payTo: destination, maxTimeoutSeconds: 180, extra: { feePayer: caller },
        });
      } catch (error) {
        if (label !== "out-of-policy" || !(error instanceof CountersignRefusal)) throw error;
        assert.equal(error.invariant, "recipient is on the mandate allowlist");
        console.log(`Live guard withheld its signature: ${error.message}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.ok(proposalId);
      assert.ok(settlementId, "HBAR review settlement must be observed");
      if (label === "in-policy") {
        assert.equal(outcome, "approved");
        assert.ok(approvedBytes);
        assert.equal(returnedBytes, true);
        console.log("Existing client verified the guard signature on unchanged frozen HTS bodies.");
        const transaction = Transaction.fromBytes(Buffer.from(approvedBytes, "base64"));
        await transaction.sign(callerKey);
        const transferred = await submit(transaction, client, "Guarded HTS transfer (network fee paid by caller)");
        assert.equal(transferred.id, proposalId);
        assertMirrorTokenTransfer(await mirrorJson(transactionMirrorUrl(transferred.id)) as { transactions: MirrorTokenTransaction[] },
          transferred.id, token, treasury, recipient, TRANSFER_UNITS);
      } else {
        assert.equal(outcome, "refused");
        assert.equal(approvedBytes, undefined);
        assert.equal(returnedBytes, false);
        while (Date.now() < expiry + 30_000) {
          console.log(`Waiting for refused proposal validity/indexing: ${Math.ceil((expiry + 30_000 - Date.now()) / 1000)} seconds remaining`);
          await sleep(Math.min(15_000, expiry + 30_000 - Date.now()));
        }
        for (let check = 0; check < 3; check += 1) {
          const url = transactionMirrorUrl(proposalId);
          const response = await fetch(url);
          console.log(`Refused HTS proposal absence ${new Date().toISOString()}: HTTP ${response.status} ${await response.text()}\n${url}`);
          assert.equal(response.status, 404);
          if (check < 2) await sleep(1500);
        }
      }
      assertMirrorSettlement(await mirrorJson(transactionMirrorUrl(settlementId)) as Parameters<typeof assertMirrorSettlement>[0],
        settlementId, caller, reviewRecipient, quotedReviewTinybars);
      console.log(`Verified ${label}: HTS authorization ${outcome}; x402 review settlement in HBAR.`);
    }
    console.log("PASS: live guarded HTS transfer and allowlist refusal verified. The x402 review settlement asset remained HBAR.");
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`HTS authorization demonstration incomplete: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    process.exitCode = 1;
  });
}
