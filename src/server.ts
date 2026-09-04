import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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
  context: Omit<ReviewContext, "requestedScheduleId">;
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

export interface ReviewServerDependencies {
  tenantId: string;
  ownerPublicKey: PublicKey;
  guardPublicKey: PublicKey;
  paymentGate: PaymentGate;
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
    agent: string;
    guard: string;
  };
  reviewObserver?: ReviewObserver;
}

export interface ReviewObserver {
  onPaymentSettled?(settlementId: string): void;
  onReviewCheck?(check: ReviewCheck): void;
}

export interface ProductionReviewServerConfig {
  tenantId: string;
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
    agentIdentifier: dependencies.participantIdentifiers.agent,
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
  if (path === "/guard" && incoming.method === "GET") {
    writeJson(response, 200, {
      guardPublicKey: dependencies.guardPublicKey.toString(),
      guardIdentifier: dependencies.participantIdentifiers.guard,
    });
    return;
  }
  if (path !== "/review") {
    throw new RequestError(404, "not found");
  }
  if (incoming.method !== "POST") {
    response.setHeader("allow", "POST");
    throw new RequestError(405, "method not allowed");
  }

  const parsedRequest = parseReviewRequest(await readJsonBody(incoming));
  if (parsedRequest.tenantId !== dependencies.tenantId) {
    throw new RequestError(
      403,
      "mandate tenant does not match the configured tenant",
    );
  }
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
    agent: generateHcs14Aid(config.participantIdentities.agent),
    guard: generateHcs14Aid(config.participantIdentities.guard),
  };
  validateVerdictParticipantIdentifiers(participantIdentifiers);
  const operatorPublicKey = client.operatorPublicKey;
  if (
    operatorPublicKey === null ||
    !operatorPublicKey.equals(config.guardPublicKey)
  ) {
    throw new Error("client operator key must equal the configured guard key");
  }

  if (
    config.ownerPublicKey.equals(config.agentPublicKey) ||
    config.ownerPublicKey.equals(config.guardPublicKey) ||
    config.agentPublicKey.equals(config.guardPublicKey)
  ) {
    throw new Error("owner, agent, and guard keys must be pairwise distinct");
  }

  const operatorAccountId = client.operatorAccountId;
  if (operatorAccountId === null) {
    throw new Error("client operator account is required");
  }
  if (
    [
      config.treasuryAccountId,
      config.expectedAgentAccountId,
      operatorAccountId.toString(),
    ].includes(config.payment.operationalAccount.accountId) ||
    [config.ownerPublicKey, config.agentPublicKey, config.guardPublicKey].some(
      (key) => config.payment.operationalAccount.publicKey.equals(key),
    )
  ) {
    throw new Error(
      "operational payment identity must be separate from authorization identities",
    );
  }

  const consensusNode = configuredConsensusNode(client);
  const [operationalAccount, treasuryAccount, agentAccount] = await Promise.all([
    services.executeAccountInfoQuery(
      client,
      new AccountInfoQuery()
        .setAccountId(config.payment.operationalAccount.accountId)
        .setNodeAccountIds([consensusNode]),
    ),
    services.executeAccountInfoQuery(
      client,
      new AccountInfoQuery()
        .setAccountId(config.treasuryAccountId)
        .setNodeAccountIds([consensusNode]),
    ),
    services.executeAccountInfoQuery(
      client,
      new AccountInfoQuery()
        .setAccountId(config.expectedAgentAccountId)
        .setNodeAccountIds([consensusNode]),
    ),
  ]);

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
  if (treasuryAccount.accountId !== config.treasuryAccountId) {
    throw new Error(
      "returned treasury account does not match the configured account",
    );
  }
  if (
    !hasExpectedTreasuryKey(
      treasuryAccount.key,
      config.ownerPublicKey,
      config.agentPublicKey,
      config.guardPublicKey,
    )
  ) {
    throw new Error(
      "treasury account must use the configured nested authorization tree",
    );
  }
  if (agentAccount.accountId !== config.expectedAgentAccountId) {
    throw new Error(
      "returned agent account does not match the configured account",
    );
  }
  if (
    !(agentAccount.key instanceof PublicKey) ||
    !agentAccount.key.equals(config.agentPublicKey)
  ) {
    throw new Error(
      "agent account key does not match the configured agent key",
    );
  }

  initializeReplayStore(config.replayDatabasePath);

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
    tenantId: config.tenantId,
    ownerPublicKey: config.ownerPublicKey,
    guardPublicKey: config.guardPublicKey,
    paymentGate,
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
          expectedAgentAccountId: config.expectedAgentAccountId,
          treasuryAccountId: config.treasuryAccountId,
          agentPublicKey: config.agentPublicKey,
          guardPublicKey: config.guardPublicKey,
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
