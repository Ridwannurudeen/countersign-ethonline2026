import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  AccountInfoQuery,
  Client,
  NetworkVersionInfoQuery,
  PublicKey,
  ScheduleId,
  ScheduleInfoQuery,
  ScheduleSignTransaction,
} from "@hiero-ledger/sdk";

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
  reserveMandateReview,
  type MandateReviewReservation,
  type MandateReviewReservationResult,
} from "./replay-store.ts";
import {
  reviewSchedule,
  type ReviewContext,
  type ReviewableScheduleInfo,
} from "./review-schedule.ts";
import {
  createHederaVerdictTopicTransport,
  openVerdictLog,
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
  context: Omit<ReviewContext, "requestedScheduleId">;
}

type ReviewResponseOutcome =
  | {
      outcome: "approved";
      recipientAccountId: string;
      amountTinybars: string;
    }
  | { outcome: "refused"; reason: string };

export interface ReviewServerDependencies {
  ownerPublicKey: PublicKey;
  paymentGate: PaymentGate;
  resolveSchedule(scheduleId: string): Promise<ResolvedSchedule>;
  reserveNonce(
    reservation: MandateReviewReservation,
  ): Awaitable<MandateReviewReservationResult>;
  submitScheduleApproval(scheduleId: string): Promise<void>;
  completeNonce(
    reservation: MandateReviewReservation,
    outcome: "approved",
  ): Awaitable<void>;
  verdictLog: VerdictLog;
  participantIdentifiers: {
    agent: string;
    guard: string;
  };
}

export interface ProductionReviewServerConfig {
  ownerPublicKey: PublicKey;
  agentPublicKey: PublicKey;
  guardPublicKey: PublicKey;
  expectedAgentAccountId: string;
  treasuryAccountId: string;
  protocolMaxFeeTinybars: string;
  allowedNetworkVersions: ReviewContext["allowedNetworkVersions"];
  replayDatabasePath: string;
  payment: Omit<PaymentGateConfig, "treasuryAuthorization">;
  verdictTopicId?: string;
  participantIdentities: {
    agent: Hcs14AgentIdentity;
    guard: Hcs14AgentIdentity;
  };
}

export interface ProductionReviewServerServices {
  loadOperationalAccount(
    client: Client,
    accountId: string,
  ): Promise<{ accountId: string; key: unknown }>;
  createPaymentGate(config: PaymentGateConfig): Promise<PaymentGate>;
  openVerdictLog(client: Client, topicId?: string): Promise<VerdictLog>;
}

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "request body must be an object");
  }

  return value as Record<string, unknown>;
}

function requireExactRequestFields(value: Record<string, unknown>): void {
  const requiredFields = ["tenantId", "mandateEnvelope", "scheduleId"] as const;
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
    request.resume();
    throw new RequestError(413, "request body exceeds the size limit");
  }

  request.setEncoding("utf8");
  const chunks: string[] = [];
  let length = 0;
  let exceedsLimit = false;

  for await (const chunk of request as AsyncIterable<string>) {
    length += Buffer.byteLength(chunk);
    if (length > MAX_REVIEW_BODY_BYTES) {
      exceedsLimit = true;
    } else {
      chunks.push(chunk);
    }
  }

  if (exceedsLimit) {
    throw new RequestError(413, "request body exceeds the size limit");
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

async function recordAndRespond(
  response: ServerResponse,
  dependencies: ReviewServerDependencies,
  request: ParsedReviewRequest,
  digest: string,
  settlementId: string,
  outcomeBody: ReviewResponseOutcome,
  paymentResponseHeaders: Readonly<Record<string, string>>,
): Promise<void> {
  const record: VerdictRecord = {
    outcome: outcomeBody.outcome,
    scheduleId: request.scheduleId,
    mandateDigest: digest,
    settlementId,
    tenantId: request.tenantId,
    agentIdentifier: dependencies.participantIdentifiers.agent,
    guardIdentifier: dependencies.participantIdentifiers.guard,
  };
  const receipt = await dependencies.verdictLog.record(record);
  if (receipt.mirrorNodeUrl.length === 0) {
    throw new Error("verdict mirror-node URL is missing");
  }

  writeJson(
    response,
    200,
    {
      ...outcomeBody,
      scheduleId: request.scheduleId,
      mandateDigest: digest,
      settlementId,
      mirrorNodeUrl: receipt.mirrorNodeUrl,
    },
    paymentResponseHeaders,
  );
}

async function handleReviewRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  dependencies: ReviewServerDependencies,
): Promise<void> {
  const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
  if (path !== "/review") {
    throw new RequestError(404, "not found");
  }
  if (incoming.method !== "POST") {
    response.setHeader("allow", "POST");
    throw new RequestError(405, "method not allowed");
  }

  const parsedRequest = parseReviewRequest(await readJsonBody(incoming));
  if (
    !verifyMandateSignature(
      parsedRequest.mandateEnvelope,
      dependencies.ownerPublicKey,
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
  for (const [name, value] of Object.entries(payment.responseHeaders)) {
    response.setHeader(name, value);
  }

  const resolved = await dependencies.resolveSchedule(parsedRequest.scheduleId);
  const digest = mandateDigest(parsedRequest.mandateEnvelope.mandate);
  const reviewOutcome = reviewSchedule(
    resolved.info,
    parsedRequest.mandateEnvelope.mandate,
    {
      ...resolved.context,
      requestedScheduleId: parsedRequest.scheduleId,
    },
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

  const reservation: MandateReviewReservation = {
    tenantId: parsedRequest.tenantId,
    nonce: parsedRequest.mandateEnvelope.mandate.nonce,
    mandateDigest: digest,
    scheduleId: parsedRequest.scheduleId,
  };
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
  } else {
    await dependencies.submitScheduleApproval(parsedRequest.scheduleId);
    await dependencies.completeNonce(reservation, "approved");
  }

  await recordAndRespond(
    response,
    dependencies,
    parsedRequest,
    digest,
    payment.settlementId,
    {
      outcome: "approved",
      recipientAccountId: reviewOutcome.recipientAccountId,
      amountTinybars: reviewOutcome.amountTinybars,
    },
    payment.responseHeaders,
  );
}

export function createReviewServer(dependencies: ReviewServerDependencies) {
  const server = createServer((request, response) => {
    void handleReviewRequest(request, response, dependencies).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }

      if (error instanceof RequestError) {
        writeJson(response, error.status, { error: error.message });
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
  async loadOperationalAccount(client, accountId) {
    const accountInfo = await new AccountInfoQuery()
      .setAccountId(accountId)
      .execute(client);
    return {
      accountId: accountInfo.accountId.toString(),
      key: accountInfo.key,
    };
  },

  createPaymentGate,

  async openVerdictLog(client, topicId) {
    return openVerdictLog(createHederaVerdictTopicTransport(client), topicId);
  },
};

export async function createProductionReviewServer(
  client: Client,
  config: ProductionReviewServerConfig,
  services: ProductionReviewServerServices = productionReviewServerServices,
) {
  const participantIdentifiers = {
    agent: generateHcs14Aid(config.participantIdentities.agent),
    guard: generateHcs14Aid(config.participantIdentities.guard),
  };
  const operatorPublicKey = client.operatorPublicKey;
  if (
    operatorPublicKey === null ||
    !operatorPublicKey.equals(config.guardPublicKey)
  ) {
    throw new Error("client operator key must equal the configured guard key");
  }

  const operationalAccount = await services.loadOperationalAccount(
    client,
    config.payment.operationalAccount.accountId,
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
  if (
    operationalAccount.accountId === config.treasuryAccountId ||
    [config.ownerPublicKey, config.agentPublicKey, config.guardPublicKey].some(
      (key) => operationalPublicKey.equals(key),
    )
  ) {
    throw new Error(
      "operational payment key must be separate from authorization keys and treasury account",
    );
  }

  const paymentGate = await services.createPaymentGate({
    ...config.payment,
    treasuryAuthorization: {
      accountId: config.treasuryAccountId,
      ownerPublicKey: config.ownerPublicKey,
      agentPublicKey: config.agentPublicKey,
      guardPublicKey: config.guardPublicKey,
    },
  });
  const verdictLog = await services.openVerdictLog(
    client,
    config.verdictTopicId,
  );

  return createReviewServer({
    ownerPublicKey: config.ownerPublicKey,
    paymentGate,
    async resolveSchedule(scheduleId) {
      const [info, networkVersionInfo] = await Promise.all([
        new ScheduleInfoQuery().setScheduleId(scheduleId).execute(client),
        new NetworkVersionInfoQuery().execute(client),
      ]);

      return {
        info,
        context: {
          expectedAgentAccountId: config.expectedAgentAccountId,
          treasuryAccountId: config.treasuryAccountId,
          agentPublicKey: config.agentPublicKey,
          guardPublicKey: config.guardPublicKey,
          protocolMaxFeeTinybars: config.protocolMaxFeeTinybars,
          nowEpochSeconds: Math.floor(Date.now() / 1_000).toString(),
          networkVersions: {
            protobuf: networkVersionInfo.protobufVersion,
            services: networkVersionInfo.servicesVersion,
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
    completeNonce(reservation, outcome) {
      completeMandateReview(config.replayDatabasePath, reservation, outcome);
    },
    verdictLog,
    participantIdentifiers,
  });
}
