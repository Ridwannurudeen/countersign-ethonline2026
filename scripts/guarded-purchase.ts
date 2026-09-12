import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { proto } from "@hiero-ledger/proto";
import { PrivateKey, PublicKey } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import {
  HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer,
  type HTTPAdapter, type RoutesConfig,
} from "@x402/core/server";
import { createClientHederaSigner, inspectHederaTransaction } from "@x402/hedera";
import { ExactHederaScheme as ClientScheme } from "@x402/hedera/exact/client";
import { ExactHederaScheme as ServerScheme } from "@x402/hedera/exact/server";

import { CountersignRefusal, createCosignedClientHederaSigner } from "../src/cosigned-client-signer.ts";
import { canonicalMandateBytes, parseMandateEnvelope, type Mandate } from "../src/mandate.ts";
import { resolveGuard } from "./hosted-review.ts";

const NETWORK = "hedera:testnet";
const PRICE = "1000000";
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const SELLER = "Seller operated by us; stock x402 libraries; no external merchant.";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

export function transactionMirrorUrl(id: string): string {
  assert.match(id, /^\d+\.\d+\.\d+@\d+\.\d{9}$/);
  return `${MIRROR}/transactions/${id.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;
}

interface MirrorTransaction {
  transaction_id: string;
  result: string;
  consensus_timestamp: string;
  transfers: { account: string; amount: number }[];
}

export function assertMirrorSettlement(
  data: { transactions: MirrorTransaction[] }, id: string,
  debitAccount: string, recipient: string, amount: string,
): MirrorTransaction {
  assert.ok(Array.isArray(data.transactions), "mirror transactions must be an array");
  const mirrorId = transactionMirrorUrl(id).split("/").at(-1);
  const matches = data.transactions.filter((tx) => tx.transaction_id === mirrorId && tx.result === "SUCCESS");
  assert.equal(matches.length, 1, "exactly one matching SUCCESS settlement must exist");
  const transaction = matches[0];
  assert.ok(Array.isArray(transaction.transfers), "mirror transfer adjustments must exist");
  for (const transfer of transaction.transfers) assert.ok(Number.isSafeInteger(transfer.amount));
  const debit = transaction.transfers.filter((transfer) => transfer.account === debitAccount)
    .reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
  const credit = transaction.transfers.filter((transfer) => transfer.account === recipient)
    .reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
  assert.equal(debit, -BigInt(amount), "the intended account must fund the exact payment");
  assert.equal(credit, BigInt(amount), "the recipient must receive the exact payment");
  return transaction;
}

interface GuardReceipt {
  outcome: string;
  invariant?: string;
  transactionId: string;
  settlementId: string;
  mirrorNodeUrl: string;
}

export interface PurchaseObservation {
  proposalId?: string;
  expiresAtMilliseconds?: number;
  review?: GuardReceipt;
  reviewSettlementId?: string;
  purchaseSettlementId?: string;
  submittedToSeller: boolean;
  error?: string;
  rejectedBy?: string;
}

export async function purchase(
  url: string, payer: x402HTTPClient, guardEndpoint: string,
): Promise<PurchaseObservation> {
  const observed: PurchaseObservation = { submittedToSeller: false };
  const originalFetch = globalThis.fetch;
  let stage = "buyer";
  // Observe responses without changing any request, response, or signed bytes.
  // This script runs sequentially and restores fetch before the next purchase.
  globalThis.fetch = async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target === guardEndpoint && typeof init?.body === "string") {
      stage = "live guard";
      const body = JSON.parse(init.body) as { transactionBase64: string };
      const inspected = inspectHederaTransaction(body.transactionBase64);
      observed.proposalId = inspected.transactionId;
      const list = proto.TransactionList.decode(Buffer.from(body.transactionBase64, "base64"));
      const signed = proto.SignedTransaction.decode(list.transactionList[0].signedTransactionBytes!);
      const transaction = proto.TransactionBody.decode(signed.bodyBytes);
      const start = transaction.transactionID!.transactionValidStart!;
      observed.expiresAtMilliseconds = Number(start.seconds!.toString()) * 1000 +
        Math.ceil((start.nanos ?? 0) / 1_000_000) +
        Number(transaction.transactionValidDuration!.seconds!.toString()) * 1000;
    }
    const response = await originalFetch(input, init);
    if (target === guardEndpoint) {
      const paid = new Headers(init?.headers).has("PAYMENT-SIGNATURE");
      console.log(`Live guard HTTP ${response.status}; paid request: ${paid}`);
      if (paid) {
        if (response.headers.has("PAYMENT-RESPONSE")) {
          const settlement = payer.getPaymentSettleResponse((name) => response.headers.get(name));
          console.log(`Review payment response: ${JSON.stringify(settlement)}`);
          if (settlement.success) observed.reviewSettlementId = settlement.transaction;
        }
        const body = await response.clone().json() as GuardReceipt & { transactionBase64?: string };
        const { transactionBase64: returnedBytes, ...receipt } = body;
        console.log(`Live guard response: ${JSON.stringify(receipt)}`);
        if (returnedBytes !== undefined) console.log("Countersigned bytes returned; verification remains in the existing client signer.");
        if (response.ok) {
          assert.ok(body.outcome === "approved" || body.outcome === "refused");
          assert.equal(body.transactionId, observed.proposalId);
          assert.equal(body.settlementId, observed.reviewSettlementId);
          assert.equal(typeof body.mirrorNodeUrl, "string");
          observed.review = receipt;
        }
      }
    }
    return response;
  };
  try {
    const challenge = await fetch(url, { method: "POST", headers: { accept: "application/json" } });
    assert.equal(challenge.status, 402, "our stock seller must issue HTTP 402");
    const requirements = payer.getPaymentRequiredResponse((name) => challenge.headers.get(name), await challenge.json());
    console.log(`Our stock seller quote: ${JSON.stringify(requirements.accepts)}`);
    const payload = await payer.createPaymentPayload(requirements);
    stage = "our stock seller / Blocky402";
    observed.submittedToSeller = true;
    const paid = await fetch(url, {
      method: "POST", headers: { accept: "application/json", ...payer.encodePaymentSignatureHeader(payload) },
    });
    const body = await paid.text();
    console.log(`Our stock seller paid response: HTTP ${paid.status} ${body}`);
    if (paid.headers.has("PAYMENT-RESPONSE")) {
      const settlement = payer.getPaymentSettleResponse((name) => paid.headers.get(name));
      console.log(`Purchase payment response: ${JSON.stringify(settlement)}`);
      if (settlement.success) observed.purchaseSettlementId = settlement.transaction;
    }
    assert.ok(paid.ok, `our stock seller / Blocky402 rejected: HTTP ${paid.status} ${body}`);
    assert.ok(observed.purchaseSettlementId, "purchase settlement ID is missing");
    assert.equal(observed.purchaseSettlementId, observed.proposalId);
  } catch (error) {
    observed.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    observed.rejectedBy = error instanceof CountersignRefusal ? "live guard authorization policy" : stage;
    console.log(`Purchase failed at ${observed.rejectedBy}: ${observed.error}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(`Purchase observation: ${JSON.stringify(observed)}`);
  return observed;
}

async function main(): Promise<void> {
  console.log(SELLER);
  const origin = required("COUNTERSIGN_GUARD_ORIGIN");
  assert.equal(origin, "https://countersign.gudman.xyz");
  const uaid = required("COUNTERSIGN_GUARD_UAID");
  const resolution = await resolveGuard(uaid, origin);
  const services = resolution.document.service as Record<string, unknown>[];
  const endpoints = services.filter((service) => service.id === "countersign");
  assert.equal(endpoints.length, 1);
  const endpoint = endpoints[0].serviceEndpoint;
  if (typeof endpoint !== "string") {
    throw new Error("agent card countersign serviceEndpoint must be a string");
  }
  assert.equal(new URL(endpoint).origin, origin);
  const guardResponse = await fetch(new URL("/guard", origin));
  assert.equal(guardResponse.status, 200);
  const guard = await guardResponse.json() as { guardIdentifier: string; guardPublicKey: string };
  assert.equal(guard.guardIdentifier, uaid);
  assert.equal(resolution.document.guardPublicKey, guard.guardPublicKey);
  const guardKey = PublicKey.fromString(guard.guardPublicKey);
  console.log(`Resolved UAID: ${uaid}\nAgent card: ${origin}/.well-known/agent.json\nCountersign endpoint: ${endpoint}`);
  console.log(`Live guard public key: ${guard.guardPublicKey}`);

  const treasury = required("COUNTERSIGN_TREASURY_ACCOUNT_ID");
  const owner = PrivateKey.fromStringDer(required("COUNTERSIGN_OWNER_PRIVATE_KEY"));
  const agent = PrivateKey.fromStringDer(required("COUNTERSIGN_AGENT_PRIVATE_KEY"));
  const caller = required("COUNTERSIGN_PAYER_ACCOUNT_ID");
  const callerKey = PrivateKey.fromStringDer(required("COUNTERSIGN_PAYER_PRIVATE_KEY"));
  const allowedRecipient = required("COUNTERSIGN_ALLOWED_RECIPIENT_ACCOUNT_ID");
  const reviewRecipient = required("COUNTERSIGN_FEE_ACCOUNT_ID");
  assert.equal(new Set([treasury, caller, allowedRecipient, reviewRecipient]).size, 4);
  const treasuryUrl = `${MIRROR}/accounts/${treasury}?transactions=false`;
  const treasuryResponse = await fetch(treasuryUrl);
  assert.equal(treasuryResponse.status, 200);
  const account = await treasuryResponse.json() as {
    account: string; deleted: boolean; key: { _type: string; key: string }; balance: { balance: number };
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
  assert.equal(account.key.key, Buffer.from(expectedKey).toString("hex"), "treasury keys must match the owner, agent and live guard");
  assert.ok(account.balance.balance >= Number(PRICE));
  console.log(`Reusing deployed treasury ${treasury}: 1-of[owner, 2-of[agent, live guard]] verified on mirror.\n${treasuryUrl}`);

  const routes: RoutesConfig = {};
  for (const [path, recipient] of [["/in-policy", allowedRecipient], ["/out-of-policy", caller]]) {
    routes[`POST ${path}`] = {
      accepts: { scheme: "exact", network: NETWORK, payTo: recipient,
        price: { asset: "0.0.0", amount: PRICE }, extra: { paymentFlow: "upfront" } },
      description: SELLER, mimeType: "application/json",
    };
  }
  const stock = new x402HTTPResourceServer(new x402ResourceServer(
    new HTTPFacilitatorClient({ url: "https://api.testnet.blocky402.com" }),
  ).register(NETWORK, new ServerScheme()), routes);
  await stock.initialize();
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      const adapter: HTTPAdapter = {
        getHeader: (name) => { const value = request.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; },
        getMethod: () => request.method!, getPath: () => path,
        getUrl: () => `http://${request.headers.host}${request.url}`,
        getAcceptHeader: () => request.headers.accept ?? "",
        getUserAgent: () => request.headers["user-agent"] ?? "",
      };
      const result = await stock.processHTTPRequest({ adapter, path, method: request.method! });
      if (result.type === "payment-error") {
        response.writeHead(result.response.status, result.response.headers);
        response.end(JSON.stringify(result.response.body));
        return;
      }
      assert.equal(result.type, "payment-verified");
      const settlement = await stock.processSettlement(
        result.paymentPayload, result.paymentRequirements, result.declaredExtensions,
        undefined, undefined, result.beforeHandlerSettlement,
      );
      if (!settlement.success) {
        response.writeHead(settlement.response.status, settlement.response.headers);
        response.end(JSON.stringify(settlement.response.body));
        return;
      }
      response.writeHead(200, { "content-type": "application/json", ...settlement.headers });
      response.end(JSON.stringify({ seller: SELLER, resource: "Local HBAR purchase authorization demonstration" }));
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Our stock seller adapter failed: ${message}`);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ seller: SELLER, error: message }));
    });
  });
  const observations: { label: string; recipient: string; observed: PurchaseObservation }[] = [];
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    console.log(`Our stock seller listening: http://127.0.0.1:${address.port}; price ${PRICE} tinybars (0.01 HBAR).`);
    for (const [index, label] of ["in-policy", "out-of-policy"].entries()) {
      console.log(`\nRUN ${index + 1}: ${label}; ${SELLER}`);
      const now = Math.floor(Date.now() / 1000);
      const mandate: Mandate = {
        tenantId: required("COUNTERSIGN_TENANT_ID"), nonce: Date.now().toString(),
        treasuryAccountId: treasury, recipientAllowlist: [allowedRecipient], maxAmountTinybars: PRICE,
        validFromEpochSeconds: (now - 60).toString(), expiresAtEpochSeconds: (now + 600).toString(),
      };
      const mandateEnvelope = parseMandateEnvelope({ mandate,
        signature: Buffer.from(owner.sign(canonicalMandateBytes(mandate))).toString("base64url") });
      const guardPaymentClient = new x402Client().register(NETWORK, new ClientScheme(
        createClientHederaSigner(caller, callerKey, { network: NETWORK }),
      )).setSpendControls({ allowedAssets: [{ network: NETWORK, asset: "0.0.0", maxAmountPerPayment: PRICE }] })
        .onBeforePaymentCreation(async ({ selectedRequirements: quote }) => {
          assert.equal(quote.payTo, reviewRecipient);
          assert.equal(quote.amount, PRICE);
          assert.equal(quote.network, NETWORK);
          assert.equal(quote.asset, "0.0.0");
          assert.equal(typeof quote.extra?.feePayer, "string");
          assert.notEqual(quote.extra.feePayer, caller);
        });
      const recipient = index === 0 ? allowedRecipient : caller;
      const payer = new x402HTTPClient(new x402Client().register(NETWORK, new ClientScheme(
        createCosignedClientHederaSigner(treasury, agent, {
          network: NETWORK, guardOrigin: origin, guardUaid: uaid,
          guardPublicKey: guardKey, mandateEnvelope, guardPaymentClient,
        }),
      )).setSpendControls({ allowedAssets: [{ network: NETWORK, asset: "0.0.0", maxAmountPerPayment: PRICE }] })
        .onBeforePaymentCreation(async ({ selectedRequirements: quote }) => {
          assert.equal(quote.payTo, recipient);
          assert.equal(quote.amount, PRICE);
        }));
      const observed = await purchase(`http://127.0.0.1:${address.port}/${label}`, payer, endpoint);
      observations.push({ label, recipient, observed });
    }
    for (const { label, recipient, observed } of observations) {
      console.log(`\nMIRROR VERIFICATION: ${label}; ${SELLER}`);
      for (const [kind, id, debit, credit] of [
        ["review fee", observed.reviewSettlementId, caller, reviewRecipient],
        ["purchase", observed.purchaseSettlementId, treasury, recipient],
      ]) {
        if (!id) { console.log(`${kind} settlement ID: absent`); continue; }
        const url = transactionMirrorUrl(id);
        let response = await fetch(url);
        for (let attempt = 0; response.status === 404 && attempt < 20; attempt += 1) {
          await sleep(1500);
          response = await fetch(url);
        }
        assert.equal(response.status, 200, `mirror ${kind}: ${url}`);
        const body: unknown = await response.json();
        if (typeof body !== "object" || body === null || !Array.isArray((body as { transactions?: unknown }).transactions)) {
          throw new Error(`mirror ${kind} response did not contain a transactions array`);
        }
        const transaction = assertMirrorSettlement(
          body as { transactions: MirrorTransaction[] },
          id,
          debit!,
          credit!,
          PRICE,
        );
        console.log(`${kind} settlement ID: ${id}\n${url}\n${JSON.stringify(transaction)}`);
      }
      if (!observed.purchaseSettlementId && observed.proposalId && observed.expiresAtMilliseconds) {
        const until = observed.expiresAtMilliseconds + 30_000;
        console.log(`Checking purchase absence after validity plus 30 seconds: ${new Date(until).toISOString()}`);
        while (Date.now() < until) {
          console.log(`Waiting for expiry/indexing: ${Math.ceil((until - Date.now()) / 1000)} seconds remaining`);
          await sleep(Math.min(15_000, until - Date.now()));
        }
        const url = transactionMirrorUrl(observed.proposalId);
        for (let check = 0; check < 3; check += 1) {
          const response = await fetch(url);
          const body = await response.text();
          console.log(`Purchase absence ${new Date().toISOString()}: HTTP ${response.status} ${body}\n${url}`);
          assert.equal(response.status, 404, "purchase transaction must be absent on mirror");
          if (check < 2) await sleep(1500);
        }
      }
      console.log(`Verdict: ${observed.review?.outcome ?? "unavailable"}; deciding invariant: ${observed.review?.invariant ?? "not returned by guard"}`);
      if (observed.review) console.log(`Guard verdict mirror: ${observed.review.mirrorNodeUrl}`);
    }
    assert.equal(observations[0].observed.review?.outcome, "approved", "in-policy run did not receive live guard approval");
    assert.ok(observations[0].observed.purchaseSettlementId, "in-policy purchase did not settle");
    assert.equal(observations[1].observed.review?.outcome, "refused");
    assert.equal(observations[1].observed.review?.invariant, "recipient is on the mandate allowlist");
    assert.ok(observations[1].observed.reviewSettlementId, "refused review fee did not settle");
    assert.equal(observations[1].observed.submittedToSeller, false);
    console.log("Both live purchase authorization cases verified.");
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    console.log("Cleanup: local seller closed. Existing deployed treasury reused; no accounts provisioned or funds added.");
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Guarded purchase failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    process.exitCode = 1;
  });
}
