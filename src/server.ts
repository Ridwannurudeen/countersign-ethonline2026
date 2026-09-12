import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { proto } from "@hiero-ledger/proto";

import {
  AccountId,
  AccountInfoQuery,
  Client,
  KeyList,
  NetworkVersionInfoQuery,
  PublicKey,
  ScheduleId,
  ScheduleInfoQuery,
  ScheduleSignTransaction,
  TransactionId,
} from "@hiero-ledger/sdk";

import { validateCountersignTransfer, type CountersignApproval, type CountersignContext } from "./countersign-transfer.ts";

import {
  mandateDigest,
  parseMandateEnvelope,
  verifyMandateSignature,
  type MandateEnvelope,
} from "./mandate.ts";
import {
  generateHcs14Aid,
  type Hcs14AgentIdentity,
} from "./hcs14.ts";
import {
  createPaymentGate,
  type PaymentGate,
  type PaymentGateConfig,
} from "./payment-gate.ts";
import {
  completeMandateReview,
  getCompletedMandateReview,
  initializeReplayStore,
  ReplayStoreContentionError,
  reserveMandateReview,
  type CompletedMandateReview,
  type MandateReviewReservation,
  type MandateReviewReservationResult,
} from "./replay-store.ts";
import {
  reviewSchedule,
  type ReviewCheck,
  type ReviewContext,
  type ReviewableScheduleInfo,
} from "./review-schedule.ts";
import {
  createHederaVerdictTopicTransport,
  openVerdictLog,
  validateVerdictParticipantIdentifiers,
  type VerdictLog,
  type VerdictRecord,
} from "./verdict-log.ts";

export const MAX_REVIEW_BODY_BYTES = 16 * 1024;

type Awaitable<T> = T | Promise<T>;

interface ParsedReviewRequest {
  tenantId: string;
  mandateEnvelope: MandateEnvelope;
  scheduleId: string;
}

export interface ResolvedSchedule {
  info: ReviewableScheduleInfo;
  context: Omit<ReviewContext,
    "requestedScheduleId" | "treasuryAccountId" | "expectedAgentAccountId" |
    "agentPublicKey" | "guardPublicKey"
  >;
  refusalReason?: string;
}

type ReviewResponseOutcome =
  | {
      outcome: "approved";
      recipientAccountId: string;
      amountTinybars: string;
    }
  | { outcome: "refused"; reason: string };

type ReviewResponseBody = ReviewResponseOutcome & {
  scheduleId: string;
  mandateDigest: string;
  settlementId: string;
  mirrorNodeUrl: string;
};

export interface ReviewTenant {
  ownerPublicKey: PublicKey;
  agentPublicKey: PublicKey;
  expectedAgentAccountId: string;
  treasuryAccountId: string;
}

export interface ProductionReviewTenant extends ReviewTenant {
  agentIdentity: Hcs14AgentIdentity;
}

export interface ReviewServerDependencies {
  countersign: {
    executeTokenInfoQuery?: CountersignContext["executeTokenInfoQuery"];
    protocolMaxFeeTinybars: string;
    nowEpochSeconds(): string;
    sign(approval: CountersignApproval): Awaitable<string>;
  };
  tenants: ReadonlyMap<string, ReviewTenant & { agentIdentifier: string }>;
  guardPublicKey: PublicKey;
  paymentGate: PaymentGate;
  payment: Pick<PaymentGateConfig, "resourceUrl" | "priceTinybars">;
  lookupCompletedReview(
    reservation: MandateReviewReservation,
  ): Awaitable<CompletedMandateReview | null>;
  resolveSchedule(scheduleId: string): Promise<ResolvedSchedule>;
  reserveNonce(
    reservation: MandateReviewReservation,
  ): Awaitable<MandateReviewReservationResult>;
  submitScheduleApproval(scheduleId: string): Promise<void>;
  completeNonce(
    reservation: MandateReviewReservation,
    completion: CompletedMandateReview,
  ): Awaitable<void>;
  verdictLog: VerdictLog;
  participantIdentifiers: {
    guard: string;
  };
  reviewObserver?: ReviewObserver;
}

export interface ReviewObserver {
  onPaymentSettled?(settlementId: string): void;
  onReviewCheck?(check: ReviewCheck): void;
}

export interface ProductionReviewServerConfig {
  signCountersign(approval: CountersignApproval): Awaitable<string>;
  tenants: ReadonlyMap<string, ProductionReviewTenant>;
  guardPublicKey: PublicKey;
  protocolMaxFeeTinybars: string;
  allowedNetworkVersions: ReviewContext["allowedNetworkVersions"];
  replayDatabasePath: string;
  payment: Omit<PaymentGateConfig, "treasuryAuthorizations">;
  verdictTopicId?: string;
  guardIdentity: Hcs14AgentIdentity;
  reviewObserver?: ReviewObserver;
}

export interface ProductionReviewServerServices {
  executeAccountInfoQuery(
    client: Client,
    query: AccountInfoQuery,
  ): Promise<{ accountId: string; key: unknown }>;
  executeNetworkVersionInfoQuery(
    client: Client,
    query: NetworkVersionInfoQuery,
  ): Promise<{
    protobufVersion: ReviewContext["networkVersions"]["protobuf"];
    servicesVersion: ReviewContext["networkVersions"]["services"];
  }>;
  executeScheduleInfoQuery(
    client: Client,
    query: ScheduleInfoQuery,
  ): Promise<ReviewableScheduleInfo>;
  createPaymentGate(config: PaymentGateConfig): Promise<PaymentGate>;
  openVerdictLog(client: Client, topicId?: string): Promise<VerdictLog>;
}

class RequestError extends Error {
  readonly status: number;
  readonly closeConnection: boolean;

  constructor(status: number, message: string, closeConnection = false) {
    super(message);
    this.status = status;
    this.closeConnection = closeConnection;
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "request body must be an object");
  }

  return value as Record<string, unknown>;
}

function requireExactRequestFields(
  value: Record<string, unknown>,
  requiredFields: readonly string[] = ["tenantId", "mandateEnvelope", "scheduleId"],
): void {
  const allowedFields = new Set<string>(requiredFields);

  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new RequestError(400, `unknown request field: ${field}`);
    }
  }

  for (const field of requiredFields) {
    if (!Object.hasOwn(value, field)) {
      throw new RequestError(400, `missing request field: ${field}`);
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RequestError(400, `${field} must be a string`);
  }

  return value;
}

function canonicalScheduleId(value: unknown): string {
  const text = requireString(value, "scheduleId");
  let parsed: ScheduleId;
  try {
    parsed = ScheduleId.fromString(text);
  } catch {
    throw new RequestError(
      400,
      "scheduleId must be a canonical numeric Hedera ScheduleID",
    );
  }

  if (parsed.toString() !== text) {
    throw new RequestError(
      400,
      "scheduleId must be a canonical numeric Hedera ScheduleID",
    );
  }

  return text;
}

function parseReviewRequest(value: unknown): ParsedReviewRequest {
  const request = requireRecord(value);
  requireExactRequestFields(request);

  const tenantId = requireString(request.tenantId, "tenantId");
  let mandateEnvelope: MandateEnvelope;
  try {
    mandateEnvelope = parseMandateEnvelope(request.mandateEnvelope);
  } catch (error) {
    throw new RequestError(
      400,
      error instanceof Error ? error.message : "mandate envelope is invalid",
    );
  }

  if (tenantId !== mandateEnvelope.mandate.tenantId) {
    throw new RequestError(
      400,
      "tenantId must match the mandate tenantId",
    );
  }

  return {
    tenantId,
    mandateEnvelope,
    scheduleId: canonicalScheduleId(request.scheduleId),
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new RequestError(415, "content-type must be application/json");
  }

  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_REVIEW_BODY_BYTES
  ) {
    request.pause();
    throw new RequestError(413, "request body exceeds the size limit", true);
  }

  request.setEncoding("utf8");
  const chunks: string[] = [];
  let length = 0;

  for await (const chunk of request as AsyncIterable<string>) {
    length += Buffer.byteLength(chunk);
    if (length > MAX_REVIEW_BODY_BYTES) {
      request.pause();
      throw new RequestError(413, "request body exceeds the size limit", true);
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(chunks.join("")) as unknown;
  } catch {
    throw new RequestError(400, "request body must contain valid JSON");
  }
}

function paymentSignatureHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["payment-signature"];
  if (Array.isArray(value)) {
    throw new RequestError(400, "payment-signature header must appear once");
  }

  return value;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const encoded = JSON.stringify(body);
  if (encoded === undefined) {
    throw new Error("response body is not JSON serializable");
  }

  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

async function recordOutcome(
  dependencies: ReviewServerDependencies,
  request: ParsedReviewRequest,
  digest: string,
  settlementId: string,
  outcomeBody: ReviewResponseOutcome,
): Promise<ReviewResponseBody> {
  const record: VerdictRecord = {
    outcome: outcomeBody.outcome,
    scheduleId: request.scheduleId,
    mandateDigest: digest,
    settlementId,
    tenantId: request.tenantId,
    agentIdentifier: dependencies.tenants.get(request.tenantId)!.agentIdentifier,
    guardIdentifier: dependencies.participantIdentifiers.guard,
  };
  const receipt = await dependencies.verdictLog.record(record);
  if (receipt.mirrorNodeUrl.length === 0) {
    throw new Error("verdict mirror-node URL is missing");
  }

  return {
    ...outcomeBody,
    scheduleId: request.scheduleId,
    mandateDigest: digest,
    settlementId,
    mirrorNodeUrl: receipt.mirrorNodeUrl,
  };
}

async function recordAndRespond(
  response: ServerResponse,
  dependencies: ReviewServerDependencies,
  request: ParsedReviewRequest,
  digest: string,
  settlementId: string,
  outcomeBody: ReviewResponseOutcome,
  paymentResponseHeaders: Readonly<Record<string, string>>,
): Promise<void> {
  writeJson(
    response,
    200,
    await recordOutcome(
      dependencies,
      request,
      digest,
      settlementId,
      outcomeBody,
    ),
    paymentResponseHeaders,
  );
}

async function handleReviewRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  dependencies: ReviewServerDependencies,
): Promise<void> {
  const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
  if (path === "/.well-known/agent.json" && incoming.method === "GET") {
    const reviewUrl = new URL("/review", dependencies.payment.resourceUrl).href;
    writeJson(response, 200, {
      name: "Countersign Guard",
      description: "Paid authorization review of Hedera schedules against owner-signed policy mandates.",
      uaid: dependencies.participantIdentifiers.guard,
      guardPublicKey: dependencies.guardPublicKey.toString(),
      url: reviewUrl,
      service: [
        { id: "review", type: "HTTP", serviceEndpoint: reviewUrl, method: "POST" },
        { id: "countersign", type: "HTTP", serviceEndpoint: new URL("/countersign", reviewUrl).href, method: "POST" },
      ],
      capabilities: {
        extensions: [{
          uri: "https://www.x402.org/",
          description: "x402 payment required for each authorization review; settled through Blocky402.",
          required: true,
          params: {
            network: "hedera:testnet",
            asset: "0.0.0",
            priceTinybars: dependencies.payment.priceTinybars,
          },
        }],
      },
      tenantCount: dependencies.tenants.size,
    });
    return;
  }
  if (path === "/guard" && incoming.method === "GET") {
    writeJson(response, 200, {
      guardPublicKey: dependencies.guardPublicKey.toString(),
      guardIdentifier: dependencies.participantIdentifiers.guard,
    });
    return;
  }
  if (path !== "/review" && path !== "/countersign") {
    throw new RequestError(404, "not found");
  }
  if (incoming.method !== "POST") {
    response.setHeader("allow", "POST");
    throw new RequestError(405, "method not allowed");
  }

  if (path === "/countersign") {
    await handleCountersignRequest(incoming, response, dependencies);
    return;
  }

  const parsedRequest = parseReviewRequest(await readJsonBody(incoming));
  const tenant = dependencies.tenants.get(parsedRequest.tenantId);
  if (tenant === undefined) {
    throw new RequestError(403, "mandate tenant is not authorized");
  }
  if (
    !verifyMandateSignature(
      parsedRequest.mandateEnvelope,
      tenant.ownerPublicKey,
    )
  ) {
    throw new RequestError(401, "mandate signature is invalid");
  }

  const payment = await dependencies.paymentGate.review(
    paymentSignatureHeader(incoming),
  );
  if (!payment.paid) {
    writeJson(response, payment.status, payment.body, payment.headers);
    return;
  }
  if (payment.settlementId.length === 0) {
    throw new Error("payment settlement ID is missing");
  }
  dependencies.reviewObserver?.onPaymentSettled?.(payment.settlementId);
  for (const [name, value] of Object.entries(payment.responseHeaders)) {
    response.setHeader(name, value);
  }

  const digest = mandateDigest(parsedRequest.mandateEnvelope.mandate);
  const reservation: MandateReviewReservation = {
    tenantId: parsedRequest.tenantId,
    nonce: parsedRequest.mandateEnvelope.mandate.nonce,
    mandateDigest: digest,
    scheduleId: parsedRequest.scheduleId,
  };
  const completedReview = await dependencies.lookupCompletedReview(reservation);
  if (completedReview !== null) {
    writeJson(
      response,
      200,
      {
        ...completedReview,
        scheduleId: parsedRequest.scheduleId,
        mandateDigest: digest,
      },
      payment.responseHeaders,
    );
    return;
  }

  const resolved = await dependencies.resolveSchedule(parsedRequest.scheduleId);
  if (resolved.refusalReason !== undefined) {
    await recordAndRespond(
      response,
      dependencies,
      parsedRequest,
      digest,
      payment.settlementId,
      { outcome: "refused", reason: resolved.refusalReason },
      payment.responseHeaders,
    );
    return;
  }
  const reviewOutcome = reviewSchedule(
    resolved.info,
    parsedRequest.mandateEnvelope.mandate,
    {
      ...resolved.context,
      treasuryAccountId: tenant.treasuryAccountId,
      expectedAgentAccountId: tenant.expectedAgentAccountId,
      agentPublicKey: tenant.agentPublicKey,
      guardPublicKey: dependencies.guardPublicKey,
      requestedScheduleId: parsedRequest.scheduleId,
    },
    (check) => dependencies.reviewObserver?.onReviewCheck?.(check),
  );

  if (!reviewOutcome.approved) {
    await recordAndRespond(
      response,
      dependencies,
      parsedRequest,
      digest,
      payment.settlementId,
      { outcome: "refused", reason: reviewOutcome.reason },
      payment.responseHeaders,
    );
    return;
  }

  const reservationResult = await dependencies.reserveNonce(reservation);

  if (reservationResult.status === "refused") {
    await recordAndRespond(
      response,
      dependencies,
      parsedRequest,
      digest,
      payment.settlementId,
      { outcome: "refused", reason: reservationResult.reason },
      payment.responseHeaders,
    );
    return;
  }

  if (reservationResult.status === "retry") {
    if (reservationResult.outcome === null) {
      await recordAndRespond(
        response,
        dependencies,
        parsedRequest,
        digest,
        payment.settlementId,
        { outcome: "refused", reason: "mandate review is already pending" },
        payment.responseHeaders,
      );
      return;
    }
    if (reservationResult.outcome !== "approved") {
      throw new Error("stored review outcome is invalid");
    }
    const concurrentCompletion = await dependencies.lookupCompletedReview(
      reservation,
    );
    if (concurrentCompletion === null) {
      throw new Error("stored review outcome is incomplete");
    }
    writeJson(
      response,
      200,
      {
        ...concurrentCompletion,
        scheduleId: parsedRequest.scheduleId,
        mandateDigest: digest,
      },
      payment.responseHeaders,
    );
    return;
  } else {
    await dependencies.submitScheduleApproval(parsedRequest.scheduleId);
  }

  const responseBody = await recordOutcome(
    dependencies,
    parsedRequest,
    digest,
    payment.settlementId,
    {
      outcome: "approved",
      recipientAccountId: reviewOutcome.recipientAccountId,
      amountTinybars: reviewOutcome.amountTinybars,
    },
  );
  await dependencies.completeNonce(reservation, {
    outcome: "approved",
    recipientAccountId: reviewOutcome.recipientAccountId,
    amountTinybars: reviewOutcome.amountTinybars,
    settlementId: responseBody.settlementId,
    mirrorNodeUrl: responseBody.mirrorNodeUrl,
  });
  writeJson(response, 200, responseBody, payment.responseHeaders);
}

function reviewedTransactionId(transactionBase64: string): string | null {
  try {
    const list = proto.TransactionList.decode(Buffer.from(transactionBase64, "base64"));
    const ids = new Set(list.transactionList.map((transaction) => {
      const signed = proto.SignedTransaction.decode(transaction.signedTransactionBytes!);
      const body = proto.TransactionBody.decode(signed.bodyBytes);
      return TransactionId._fromProtobuf(body.transactionID!).toString();
    }));
    return ids.size === 1 ? [...ids][0] : null;
  } catch {
    // Malformed input still gets a paid refusal, bound to its byte digest.
    return null;
  }
}

async function handleCountersignRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  dependencies: ReviewServerDependencies,
): Promise<void> {
  const request = requireRecord(await readJsonBody(incoming));
  requireExactRequestFields(request, ["tenantId", "mandateEnvelope", "transactionBase64"]);
  const tenantId = requireString(request.tenantId, "tenantId");
  const transactionBase64 = requireString(request.transactionBase64, "transactionBase64");
  let envelope: MandateEnvelope;
  try {
    envelope = parseMandateEnvelope(request.mandateEnvelope);
  } catch (error) {
    throw new RequestError(400, error instanceof Error ? error.message : "mandate envelope is invalid");
  }
  if (tenantId !== envelope.mandate.tenantId) {
    throw new RequestError(400, "tenantId must match the mandate tenantId");
  }
  const tenant = dependencies.tenants.get(tenantId);
  if (tenant === undefined) {
    throw new RequestError(403, "mandate tenant is not authorized");
  }
  const payment = await dependencies.paymentGate.review(paymentSignatureHeader(incoming), "/countersign");
  if (!payment.paid) {
    writeJson(response, payment.status, payment.body, payment.headers);
    return;
  }
  if (payment.settlementId.length === 0) {
    throw new Error("payment settlement ID is missing");
  }
  dependencies.reviewObserver?.onPaymentSettled?.(payment.settlementId);
  for (const [name, value] of Object.entries(payment.responseHeaders)) {
    response.setHeader(name, value);
  }
  const digest = mandateDigest(envelope.mandate);
  const transactionDigest = createHash("sha256").update(Buffer.from(transactionBase64, "base64")).digest("hex");
  const transactionId = reviewedTransactionId(transactionBase64);
  const outcome = await validateCountersignTransfer(transactionBase64, envelope, {
    ...tenant,
    guardPublicKey: dependencies.guardPublicKey,
    protocolMaxFeeTinybars: dependencies.countersign.protocolMaxFeeTinybars,
    nowEpochSeconds: dependencies.countersign.nowEpochSeconds(),
    executeTokenInfoQuery: dependencies.countersign.executeTokenInfoQuery,
  }, (check) => dependencies.reviewObserver?.onReviewCheck?.(check));
  let result: { outcome: "approved"; transactionBase64: string } | { outcome: "refused"; invariant: string };
  if (!outcome.approved) {
    result = { outcome: "refused", invariant: outcome.invariant };
  } else {
    const reservation = await dependencies.reserveNonce({
      tenantId, nonce: envelope.mandate.nonce, mandateDigest: digest, transactionDigest,
    });
    if (reservation.status !== "reserved") {
      result = {
        outcome: "refused",
        invariant: reservation.status === "refused" ? reservation.reason : "mandate nonce has already been reserved",
      };
    } else {
      result = { outcome: "approved", transactionBase64: await dependencies.countersign.sign(outcome) };
    }
  }
  const receipt = await dependencies.verdictLog.record({
    outcome: result.outcome,
    transactionId,
    transactionDigest,
    ...(result.outcome === "refused" ? { invariant: result.invariant } : {}),
    mandateDigest: digest,
    settlementId: payment.settlementId,
    tenantId,
    agentIdentifier: tenant.agentIdentifier,
    guardIdentifier: dependencies.participantIdentifiers.guard,
  });
  if (receipt.mirrorNodeUrl.length === 0) {
    throw new Error("verdict mirror-node URL is missing");
  }
  writeJson(response, 200, {
    ...result, transactionId, transactionDigest, mandateDigest: digest,
    settlementId: payment.settlementId, mirrorNodeUrl: receipt.mirrorNodeUrl,
  }, payment.responseHeaders);
}

export function createReviewServer(dependencies: ReviewServerDependencies) {
  const server = createServer((request, response) => {
    void handleReviewRequest(request, response, dependencies).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }

      if (error instanceof RequestError) {
        if (error.closeConnection) {
          response.setHeader("connection", "close");
        }
        writeJson(response, error.status, { error: error.message });
        return;
      }

      if (error instanceof ReplayStoreContentionError) {
        writeJson(
          response,
          503,
          { error: error.message },
          { "retry-after": "1" },
        );
        return;
      }

      writeJson(response, 500, { error: "internal server error" });
    });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

const productionReviewServerServices: ProductionReviewServerServices = {
  async executeAccountInfoQuery(client, query) {
    const accountInfo = await query.execute(client);
    return {
      accountId: accountInfo.accountId.toString(),
      key: accountInfo.key,
    };
  },

  executeNetworkVersionInfoQuery(client, query) {
    return query.execute(client);
  },

  executeScheduleInfoQuery(client, query) {
    return query.execute(client);
  },

  createPaymentGate,

  async openVerdictLog(client, topicId) {
    return openVerdictLog(createHederaVerdictTopicTransport(client), topicId);
  },
};

function configuredConsensusNode(client: Client): AccountId {
  const nodes = Object.values(client.network)
    .map((node) =>
      typeof node === "string" ? AccountId.fromString(node) : node,
    )
    .sort((left, right) => left.toString().localeCompare(right.toString()));
  const node = nodes[0];
  if (node === undefined) {
    throw new Error("client network must contain a consensus node");
  }
  return node;
}

function hasExpectedTreasuryKey(
  key: unknown,
  ownerPublicKey: PublicKey,
  agentPublicKey: PublicKey,
  guardPublicKey: PublicKey,
): boolean {
  if (!(key instanceof KeyList) || key.threshold !== 1) {
    return false;
  }
  const outerKeys = key.toArray();
  if (outerKeys.length !== 2) {
    return false;
  }
  const ownerBranches = outerKeys.filter(
    (branch) =>
      branch instanceof PublicKey && branch.equals(ownerPublicKey),
  );
  const innerBranches = outerKeys.filter(
    (branch): branch is KeyList => branch instanceof KeyList,
  );
  if (ownerBranches.length !== 1 || innerBranches.length !== 1) {
    return false;
  }

  const innerKey = innerBranches[0];
  if (innerKey === undefined || innerKey.threshold !== 2) {
    return false;
  }
  const innerKeys = innerKey.toArray();
  return (
    innerKeys.length === 2 &&
    innerKeys.every((branch) => branch instanceof PublicKey) &&
    innerKeys.some(
      (branch) =>
        branch instanceof PublicKey && branch.equals(agentPublicKey),
    ) &&
    innerKeys.some(
      (branch) =>
        branch instanceof PublicKey && branch.equals(guardPublicKey),
    )
  );
}

function formatNetworkVersion(
  version: ReviewContext["networkVersions"]["protobuf"],
): string | null {
  const components = [version.major, version.minor, version.patch];
  if (
    components.some(
      (component) =>
        !Number.isSafeInteger(component) || component < 0,
    )
  ) {
    return null;
  }
  return components.join(".");
}

function networkVersionsMatch(
  versions: {
    protobufVersion: ReviewContext["networkVersions"]["protobuf"];
    servicesVersion: ReviewContext["networkVersions"]["services"];
  },
  allowed: ReviewContext["allowedNetworkVersions"],
): boolean {
  return (
    formatNetworkVersion(versions.protobufVersion) === allowed.protobuf &&
    formatNetworkVersion(versions.servicesVersion) === allowed.services
  );
}

export async function createProductionReviewServer(
  client: Client,
  config: ProductionReviewServerConfig,
  services: ProductionReviewServerServices = productionReviewServerServices,
) {
  const participantIdentifiers = {
    guard: generateHcs14Aid(config.guardIdentity),
  };
  const tenants = new Map<string, ProductionReviewTenant & { agentIdentifier: string }>();
  for (const [tenantId, tenant] of config.tenants) {
    if (tenantId.trim() === "" || tenantId !== tenantId.trim()) {
      throw new Error("tenantId must be a non-empty trimmed string");
    }
    const agentIdentifier = generateHcs14Aid(tenant.agentIdentity);
    validateVerdictParticipantIdentifiers({ ...participantIdentifiers, agent: agentIdentifier });
    if (tenant.agentIdentity.nativeId !== `hedera:testnet:${tenant.expectedAgentAccountId}`) {
      throw new Error(`tenant ${tenantId}: agent identity must match the configured agent account`);
    }
    tenants.set(tenantId, { ...tenant, agentIdentifier });
  }
  if (tenants.size === 0) {
    throw new Error("at least one tenant must be configured");
  }
  const operatorPublicKey = client.operatorPublicKey;
  if (
    operatorPublicKey === null ||
    !operatorPublicKey.equals(config.guardPublicKey)
  ) {
    throw new Error("client operator key must equal the configured guard key");
  }

  const operatorAccountId = client.operatorAccountId;
  if (operatorAccountId === null) {
    throw new Error("client operator account is required");
  }
  for (const [tenantId, tenant] of tenants) {
    if (
      tenant.ownerPublicKey.equals(tenant.agentPublicKey) ||
      tenant.ownerPublicKey.equals(config.guardPublicKey) ||
      tenant.agentPublicKey.equals(config.guardPublicKey)
    ) {
      throw new Error(`tenant ${tenantId}: owner, agent, and guard keys must be pairwise distinct`);
    }
    if (
      [tenant.treasuryAccountId, tenant.expectedAgentAccountId, operatorAccountId.toString()]
        .includes(config.payment.operationalAccount.accountId) ||
      [tenant.ownerPublicKey, tenant.agentPublicKey, config.guardPublicKey].some(
        (key) => config.payment.operationalAccount.publicKey.equals(key),
      )
    ) {
      throw new Error(`tenant ${tenantId}: operational payment identity must be separate from authorization identities`);
    }
  }

  const consensusNode = configuredConsensusNode(client);
  const operationalAccount = await services.executeAccountInfoQuery(
    client,
    new AccountInfoQuery()
      .setAccountId(config.payment.operationalAccount.accountId)
      .setNodeAccountIds([consensusNode]),
  );

  if (
    operationalAccount.accountId !==
    config.payment.operationalAccount.accountId
  ) {
    throw new Error(
      "returned operational payment account does not match the configured account",
    );
  }
  const operationalPublicKey = operationalAccount.key;
  if (!(operationalPublicKey instanceof PublicKey)) {
    throw new Error("operational payment account must use a single public key");
  }
  if (!operationalPublicKey.equals(config.payment.operationalAccount.publicKey)) {
    throw new Error(
      "operational payment account key does not match the configured operational key",
    );
  }
  for (const [tenantId, tenant] of tenants) {
    try {
      const treasuryAccount = await services.executeAccountInfoQuery(
        client,
        new AccountInfoQuery().setAccountId(tenant.treasuryAccountId)
          .setNodeAccountIds([consensusNode]),
      );
      const agentAccount = await services.executeAccountInfoQuery(
        client,
        new AccountInfoQuery().setAccountId(tenant.expectedAgentAccountId)
          .setNodeAccountIds([consensusNode]),
      );
      if (treasuryAccount.accountId !== tenant.treasuryAccountId) {
        throw new Error(
          "returned treasury account does not match the configured account",
        );
      }
      if (
        !hasExpectedTreasuryKey(
          treasuryAccount.key,
          tenant.ownerPublicKey,
          tenant.agentPublicKey,
          config.guardPublicKey,
        )
      ) {
        throw new Error(
          "treasury account must use the configured nested authorization tree",
        );
      }
      if (agentAccount.accountId !== tenant.expectedAgentAccountId) {
        throw new Error(
          "returned agent account does not match the configured account",
        );
      }
      if (
        !(agentAccount.key instanceof PublicKey) ||
        !agentAccount.key.equals(tenant.agentPublicKey)
      ) {
        throw new Error(
          "agent account key does not match the configured agent key",
        );
      }
    } catch (error) {
      throw new Error(`tenant ${tenantId}: ${error instanceof Error ? error.message : "consensus validation failed"}`, { cause: error });
    }
  }

  initializeReplayStore(config.replayDatabasePath);

  const paymentGate = await services.createPaymentGate({
    ...config.payment,
    treasuryAuthorizations: [...tenants.values()].map((tenant) => ({
      accountId: tenant.treasuryAccountId,
      ownerPublicKey: tenant.ownerPublicKey,
      agentPublicKey: tenant.agentPublicKey,
      guardPublicKey: config.guardPublicKey,
    })),
  });
  const verdictLog = await services.openVerdictLog(
    client,
    config.verdictTopicId,
  );

  return createReviewServer({
    countersign: {
      executeTokenInfoQuery: (query) => query.execute(client),
      protocolMaxFeeTinybars: config.protocolMaxFeeTinybars,
      nowEpochSeconds: () => Math.floor(Date.now() / 1_000).toString(),
      sign: config.signCountersign,
    },
    tenants,
    guardPublicKey: config.guardPublicKey,
    paymentGate,
    payment: config.payment,
    lookupCompletedReview(reservation) {
      return getCompletedMandateReview(
        config.replayDatabasePath,
        reservation,
      );
    },
    async resolveSchedule(scheduleId) {
      const versionBefore = await services.executeNetworkVersionInfoQuery(
        client,
        new NetworkVersionInfoQuery().setNodeAccountIds([consensusNode]),
      );
      const info = await services.executeScheduleInfoQuery(
        client,
        new ScheduleInfoQuery()
          .setScheduleId(scheduleId)
          .setNodeAccountIds([consensusNode]),
      );
      const versionAfter = await services.executeNetworkVersionInfoQuery(
        client,
        new NetworkVersionInfoQuery().setNodeAccountIds([consensusNode]),
      );

      let refusalReason: string | undefined;
      if (!networkVersionsMatch(versionBefore, config.allowedNetworkVersions)) {
        refusalReason =
          "network version before schedule resolution is outside the audited allowlist";
      } else if (
        !networkVersionsMatch(versionAfter, config.allowedNetworkVersions)
      ) {
        refusalReason =
          "network version after schedule resolution is outside the audited allowlist";
      }

      return {
        info,
        refusalReason,
        context: {
          protocolMaxFeeTinybars: config.protocolMaxFeeTinybars,
          nowEpochSeconds: Math.floor(Date.now() / 1_000).toString(),
          networkVersions: {
            protobuf: versionBefore.protobufVersion,
            services: versionBefore.servicesVersion,
          },
          allowedNetworkVersions: config.allowedNetworkVersions,
        },
      };
    },
    reserveNonce(reservation) {
      return reserveMandateReview(config.replayDatabasePath, reservation);
    },
    async submitScheduleApproval(scheduleId) {
      const transactionResponse = await new ScheduleSignTransaction()
        .setScheduleId(scheduleId)
        .execute(client);
      await transactionResponse.getReceipt(client);
    },
    completeNonce(reservation, completion) {
      completeMandateReview(
        config.replayDatabasePath,
        reservation,
        completion,
      );
    },
    verdictLog,
    participantIdentifiers,
    reviewObserver: config.reviewObserver,
  });
}
