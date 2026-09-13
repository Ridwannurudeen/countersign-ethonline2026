import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient, decodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import { A2A_X402_EXTENSION, a2aLoopbackOrigin } from "../src/a2a.ts";
import { mandateDigest, parseMandateEnvelope } from "../src/mandate.ts";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object in the A2A response");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("Expected a non-empty string in the A2A response");
  return value;
}

export interface A2aClientOptions {
  origin: string;
  expectedUaid: string;
  expectedGuardPublicKey: string;
  expectedPayTo: string;
  maxAmountTinybars: string;
  payerAccountId: string;
  reviewRequest: Record<string, unknown>;
  createPaymentPayload(terms: PaymentRequired): Promise<PaymentPayload>;
  onEvent?(event: Record<string, unknown>): void;
}

// One quote and one payment submission. Unknown settlement outcomes need operator review.
export async function settleA2aReview(options: A2aClientOptions): Promise<Record<string, unknown>> {
  const origin = a2aLoopbackOrigin(options.origin);
  if (!/^[1-9][0-9]*$/.test(options.maxAmountTinybars)) throw new Error("A positive payment ceiling is required");
  const envelope = parseMandateEnvelope(options.reviewRequest.mandateEnvelope);
  const cardResponse = await fetch(new URL("/.well-known/agent.json", origin), { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!cardResponse.ok) throw new Error(`Agent card returned HTTP ${cardResponse.status}`);
  const card = record(await cardResponse.json());
  if (card.uaid !== options.expectedUaid || card.guardPublicKey !== options.expectedGuardPublicKey ||
      card.protocolVersion !== "0.3.0" || card.preferredTransport !== "JSONRPC" ||
      !Array.isArray(card.skills) || !card.skills.some((skill: unknown) => record(skill).id === "review")) {
    throw new Error("Agent card does not match the expected guard and A2A review skill");
  }
  const endpoint = new URL(text(card.url));
  if (endpoint.href !== new URL("/a2a", origin).href) throw new Error("A2A endpoint must match the configured local origin");
  const capabilities = record(card.capabilities);
  if (!Array.isArray(capabilities.extensions) || !capabilities.extensions.some((extension: unknown) => record(extension).uri === A2A_X402_EXTENSION)) {
    throw new Error("Agent card does not advertise the x402 extension");
  }
  if (!Array.isArray(card.service)) throw new Error("Guard review service is missing");
  const reviews = card.service.map((service: unknown) => record(service)).filter((service) => service.id === "review");
  if (reviews.length !== 1) throw new Error("Expected one guard review service");
  const reviewUrl = text(reviews[0].serviceEndpoint);
  options.onEvent?.({ event: "agent-card", uaid: card.uaid, protocolVersion: card.protocolVersion, url: endpoint.href });

  async function rpc(method: string, params: Record<string, unknown>) {
    const id = randomUUID();
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(130_000),
      headers: { "content-type": "application/json", "a2a-extensions": A2A_X402_EXTENSION },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error(`A2A returned HTTP ${response.status}; do not automatically pay again`);
    const reply = record(await response.json());
    if (reply.jsonrpc !== "2.0" || reply.id !== id) throw new Error("A2A response id mismatch");
    if (reply.error !== undefined) throw new Error(`A2A request failed: ${text(record(reply.error).message)}`);
    const task = record(reply.result);
    if (task.kind !== "task") throw new Error("Expected an A2A task");
    return task;
  }

  const unpaid = await rpc("message/send", { message: {
    kind: "message", role: "user", messageId: randomUUID(),
    parts: [{ kind: "data", data: options.reviewRequest }],
  } });
  const taskId = text(unpaid.id);
  const contextId = text(unpaid.contextId);
  const unpaidStatus = record(unpaid.status);
  const metadata = record(record(unpaidStatus.message).metadata);
  if (unpaidStatus.state !== "input-required" || metadata["x402.payment.status"] !== "payment-required") {
    throw new Error("Expected payment-required task terms");
  }
  const rawTerms = metadata["x402.payment.required"];
  if (!PaymentRequiredV2Schema.safeParse(rawTerms).success) throw new Error("Invalid x402 payment terms");
  const terms = decodePaymentRequiredHeader(Buffer.from(JSON.stringify(rawTerms)).toString("base64"));
  const quote = terms.accepts[0];
  if (terms.accepts.length !== 1 || terms.resource.url !== reviewUrl || quote.scheme !== "exact" ||
      quote.network !== "hedera:testnet" || quote.asset !== "0.0.0" || quote.payTo !== options.expectedPayTo ||
      !/^[1-9][0-9]*$/.test(quote.amount) || BigInt(quote.amount) > BigInt(options.maxAmountTinybars) ||
      typeof quote.extra?.feePayer !== "string" || quote.extra.feePayer === options.payerAccountId) {
    throw new Error("Payment terms exceed the configured authorization");
  }
  options.onEvent?.({ event: "payment-required", taskId, terms });
  const pending = await rpc("tasks/get", { id: taskId });
  if (pending.id !== taskId || pending.contextId !== contextId || record(pending.status).state !== "input-required") throw new Error("Task changed before payment");
  const payload = await options.createPaymentPayload(terms);
  const paid = await rpc("message/send", { message: {
    kind: "message", role: "user", messageId: randomUUID(), taskId, contextId,
    parts: [{ kind: "text", text: "Accept the quoted authorization review terms." }],
    metadata: { "x402.payment.status": "payment-submitted", "x402.payment.payload": payload },
  } });
  if (paid.id !== taskId || paid.contextId !== contextId || record(paid.status).state !== "completed") {
    options.onEvent?.({ event: "review-incomplete", taskId, status: paid.status });
    throw new Error("Review did not complete; inspect task state and settlement before further action");
  }
  const completed = await rpc("tasks/get", { id: taskId });
  if (completed.id !== taskId || completed.contextId !== contextId || record(completed.status).state !== "completed" || !Array.isArray(completed.artifacts)) {
    throw new Error("Completed task is unavailable");
  }
  const artifact = record(completed.artifacts[0]);
  if (!Array.isArray(artifact.parts)) throw new Error("Verdict artifact missing");
  const verdict = record(record(artifact.parts[0]).data);
  const receipts = record(record(record(completed.status).message).metadata)["x402.payment.receipts"];
  if (!Array.isArray(receipts) || receipts.length !== 1) throw new Error("Settlement receipt missing");
  const receipt = record(receipts[0]);
  if (receipt.success !== true || receipt.network !== "hedera:testnet" || receipt.transaction !== verdict.settlementId ||
      (verdict.outcome !== "approved" && verdict.outcome !== "refused") ||
      verdict.scheduleId !== options.reviewRequest.scheduleId || verdict.mandateDigest !== mandateDigest(envelope.mandate)) {
    throw new Error("Verdict or settlement does not match the review request");
  }
  options.onEvent?.({ event: "completed", taskId, receipt, verdict });
  return verdict;
}

if (import.meta.main) {
  const requestPath = process.argv[2];
  if (requestPath === undefined) throw new Error("Usage: node --experimental-strip-types scripts/a2a-client.ts <review-request.json>");
  const required = (name: string) => {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") throw new Error(`Missing ${name}`);
    return value.trim();
  };
  const payerAccountId = required("COUNTERSIGN_PAYER_ACCOUNT_ID");
  const maxAmountTinybars = required("COUNTERSIGN_A2A_MAX_PAYMENT_TINYBARS");
  const payer = new x402HTTPClient(new x402Client().register("hedera:testnet", new ExactHederaScheme(
    createClientHederaSigner(payerAccountId, PrivateKey.fromStringDer(required("COUNTERSIGN_PAYER_PRIVATE_KEY")), { network: "hedera:testnet" }),
  )).setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: maxAmountTinybars }] }));
  console.log("Task settlement over A2A, not open-ended negotiation.");
  await settleA2aReview({
    origin: required("COUNTERSIGN_A2A_ORIGIN"), expectedUaid: required("COUNTERSIGN_GUARD_UAID"),
    expectedGuardPublicKey: required("COUNTERSIGN_GUARD_PUBLIC_KEY"), expectedPayTo: required("COUNTERSIGN_FEE_ACCOUNT_ID"),
    maxAmountTinybars, payerAccountId, reviewRequest: record(JSON.parse(readFileSync(requestPath, "utf8"))),
    createPaymentPayload: (terms) => payer.createPaymentPayload(terms),
    onEvent: (event) => console.log(JSON.stringify(event)),
  });
}
