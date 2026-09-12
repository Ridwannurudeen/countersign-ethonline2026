import { mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import {
  AccountBalanceQuery,
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  KeyList,
  NetworkVersionInfoQuery,
  PrivateKey,
  ScheduleCreateTransaction,
  type ScheduleId,
  Timestamp,
  TransferTransaction,
  type Key,
} from "@hiero-ledger/sdk";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import {
  accountMirrorNodeUrl,
  assertExecutedScheduleEvidence,
  assertPendingScheduleEvidence,
  parseScheduleEvidence,
  scheduleMirrorNodeUrl,
  type ExpectedScheduleEvidence,
  type ScheduleEvidence,
} from "../src/evidence-links.ts";
import {
  canonicalMandateBytes,
  mandateDigest,
  parseMandateEnvelope,
  verifyMandateSignature,
  type Mandate,
  type MandateEnvelope,
} from "../src/mandate.ts";
import { createProductionReviewServer } from "../src/server.ts";

const HEDERA_TESTNET = "hedera:testnet";
const HBAR_ASSET_ID = "0.0.0";
const GUARD_HOST = "127.0.0.1";
const GUARD_PORT = 4020;
const GUARD_URL = `http://${GUARD_HOST}:${GUARD_PORT}/review`;
const PROTOCOL_MAX_FEE_TINYBARS = "100000000";
const REVIEW_PRICE_TINYBARS = "1000000";
const TREASURY_INITIAL_BALANCE_TINYBARS = "2000000000";
const AGENT_INITIAL_BALANCE_TINYBARS = "500000000";
const GUARD_INITIAL_BALANCE_TINYBARS = "500000000";
const PAYMENT_PAYER_INITIAL_BALANCE_TINYBARS = "100000000";
const MANDATE_CAP_TINYBARS = "50000000";
const TRANSFER_TINYBARS = "25000000";
const MIRROR_ATTEMPTS = 20;
const MIRROR_RETRY_MILLISECONDS = 1_500;

export type LiveFlowOutcome = "approved" | "refused";

interface DemoEnvironment {
  readonly operatorAccountId: string;
  readonly operatorPrivateKey: string;
  readonly allowedProtobufVersion: string;
  readonly allowedServicesVersion: string;
}

interface TemporaryAccount {
  readonly accountId: AccountId;
  readonly privateKey: PrivateKey;
  readonly label: string;
}

interface ReviewResponseBase {
  readonly scheduleId: string;
  readonly mandateDigest: string;
  readonly settlementId: string;
  readonly mirrorNodeUrl: string;
}

type ReviewResponse =
  | (ReviewResponseBase & {
      readonly outcome: "approved";
      readonly recipientAccountId: string;
      readonly amountTinybars: string;
    })
  | (ReviewResponseBase & {
      readonly outcome: "refused";
      readonly reason: string;
    });

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value == null || value.length === 0) {
    throw new Error(`missing required environment variable: ${name}`);
  }

  return value;
}

function requireVersion(value: string, name: string): string {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a major.minor.patch version`);
  }

  return value;
}

function loadEnvironment(): DemoEnvironment {
  const operatorAccountId = requireEnvironmentVariable(
    "HEDERA_OPERATOR_ACCOUNT_ID",
  );
  const operatorPrivateKey = requireEnvironmentVariable(
    "HEDERA_OPERATOR_PRIVATE_KEY",
  );
  const allowedProtobufVersion = requireEnvironmentVariable(
    "COUNTERSIGN_ALLOWED_PROTOBUF_VERSION",
  );
  const allowedServicesVersion = requireEnvironmentVariable(
    "COUNTERSIGN_ALLOWED_SERVICES_VERSION",
  );

  return {
    operatorAccountId,
    operatorPrivateKey,
    allowedProtobufVersion: requireVersion(
      allowedProtobufVersion,
      "COUNTERSIGN_ALLOWED_PROTOBUF_VERSION",
    ),
    allowedServicesVersion: requireVersion(
      allowedServicesVersion,
      "COUNTERSIGN_ALLOWED_SERVICES_VERSION",
    ),
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }

  return value;
}

function parseReviewResponse(value: unknown): ReviewResponse {
  const record = requireRecord(value, "guard response");
  const base: ReviewResponseBase = {
    scheduleId: requireString(record.scheduleId, "scheduleId"),
    mandateDigest: requireString(record.mandateDigest, "mandateDigest"),
    settlementId: requireString(record.settlementId, "settlementId"),
    mirrorNodeUrl: requireString(record.mirrorNodeUrl, "mirrorNodeUrl"),
  };

  if (record.outcome === "approved") {
    return {
      ...base,
      outcome: "approved",
      recipientAccountId: requireString(
        record.recipientAccountId,
        "recipientAccountId",
      ),
      amountTinybars: requireString(record.amountTinybars, "amountTinybars"),
    };
  }
  if (record.outcome === "refused") {
    return {
      ...base,
      outcome: "refused",
      reason: requireString(record.reason, "reason"),
    };
  }

  throw new Error("guard response outcome must be approved or refused");
}

function formatVersion(version: {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function createAccount(
  client: Client,
  key: Key,
  initialBalanceTinybars: string,
  label: string,
): Promise<AccountId> {
  const response = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key)
    .setInitialBalance(Hbar.fromTinybars(initialBalanceTinybars))
    .execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.accountId == null) {
    throw new Error(`${label} account receipt did not contain an account ID`);
  }

  console.log(`  ${label}: ${receipt.accountId.toString()}`);
  console.log(`  Evidence: ${accountMirrorNodeUrl(receipt.accountId)}`);
  return receipt.accountId;
}

async function queryTinybarBalance(
  client: Client,
  accountId: AccountId,
): Promise<bigint> {
  const balance = await new AccountBalanceQuery()
    .setAccountId(accountId)
    .execute(client);
  return BigInt(balance.hbars.toTinybars().toString());
}

async function recoverTemporaryBalance(
  operatorClient: Client,
  operatorAccountId: AccountId,
  sourceAccountId: AccountId,
  sourcePrivateKey: PrivateKey,
  label: string,
): Promise<void> {
  const balance = await queryTinybarBalance(operatorClient, sourceAccountId);
  if (balance === 0n) {
    return;
  }

  const amount = Hbar.fromTinybars(balance.toString());
  const transaction = new TransferTransaction()
    .addHbarTransfer(sourceAccountId, amount.negated())
    .addHbarTransfer(operatorAccountId, amount)
    .freezeWith(operatorClient);
  await transaction.sign(sourcePrivateKey);
  const response = await transaction.execute(operatorClient);
  await response.getReceipt(operatorClient);

  const remaining = await queryTinybarBalance(operatorClient, sourceAccountId);
  if (remaining !== 0n) {
    throw new Error(`${label} balance recovery was incomplete`);
  }
  console.log(`  ${label}: ${balance.toString()} tinybars recovered`);
  console.log(`  Account evidence: ${accountMirrorNodeUrl(sourceAccountId)}`);
}

function recordCleanupFailure(
  failures: Error[],
  label: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const failure = new Error(`${label}: ${message}`, { cause: error });
  failures.push(failure);
  console.error(`Cleanup failure: ${failure.message}`);
}

async function createHbarSchedule(
  client: Client,
  treasuryAccountId: AccountId,
  recipientAccountId: AccountId,
  agentAccountId: AccountId,
  digest: string,
  expirationTime: Timestamp,
): Promise<ScheduleId> {
  const amount = Hbar.fromTinybars(TRANSFER_TINYBARS);
  const transfer = new TransferTransaction()
    .addHbarTransfer(treasuryAccountId, amount.negated())
    .addHbarTransfer(recipientAccountId, amount)
    .setMaxTransactionFee(Hbar.fromTinybars(PROTOCOL_MAX_FEE_TINYBARS))
    .setTransactionMemo(digest);

  const response = await new ScheduleCreateTransaction()
    .setScheduledTransaction(transfer)
    .setPayerAccountId(agentAccountId)
    .setScheduleMemo(digest)
    .setExpirationTime(expirationTime)
    .setWaitForExpiry(false)
    .execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.scheduleId == null) {
    throw new Error("schedule creation receipt did not contain a ScheduleID");
  }

  return receipt.scheduleId;
}

async function fetchScheduleEvidence(
  scheduleId: ScheduleId,
): Promise<ScheduleEvidence> {
  const url = scheduleMirrorNodeUrl(scheduleId);
  for (let attempt = 1; attempt <= MIRROR_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404 && attempt < MIRROR_ATTEMPTS) {
      await sleep(MIRROR_RETRY_MILLISECONDS);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `mirror schedule query failed with HTTP ${response.status}`,
      );
    }

    return parseScheduleEvidence((await response.json()) as unknown);
  }

  throw new Error("mirror schedule did not become available");
}

async function waitForExecutedScheduleEvidence(
  scheduleId: ScheduleId,
  expected: ExpectedScheduleEvidence,
): Promise<ScheduleEvidence> {
  let lastEvidenceError: unknown;
  for (let attempt = 1; attempt <= MIRROR_ATTEMPTS; attempt += 1) {
    try {
      const evidence = await fetchScheduleEvidence(scheduleId);
      assertExecutedScheduleEvidence(evidence, expected);
      return evidence;
    } catch (error) {
      lastEvidenceError = error;
      if (attempt < MIRROR_ATTEMPTS) {
        await sleep(MIRROR_RETRY_MILLISECONDS);
      }
    }
  }

  throw new Error("mirror node did not confirm schedule execution", {
    cause: lastEvidenceError,
  });
}

function printScheduleEvidence(evidence: ScheduleEvidence): void {
  console.log(
    JSON.stringify(
      {
        creator_account_id: evidence.creatorAccountId,
        payer_account_id: evidence.payerAccountId,
        executed_timestamp: evidence.executedTimestamp,
        deleted: evidence.deleted,
        // public_key_prefix is printed exactly as the mirror node returns it,
        // so this output can be compared field by field with the evidence URL.
        signatures: evidence.publicKeyPrefixes.map((publicKeyHex) => ({
          public_key_prefix: Buffer.from(publicKeyHex, "hex").toString(
            "base64",
          ),
          public_key_hex: publicKeyHex,
        })),
      },
      null,
      2,
    ),
  );
}

function buildMandate(
  outcome: LiveFlowOutcome,
  ownerPrivateKey: PrivateKey,
  treasuryAccountId: AccountId,
  allowedRecipientAccountId: AccountId,
  nowEpochSeconds: number,
): MandateEnvelope {
  const mandate: Mandate = {
    tenantId: outcome === "approved" ? "demo-approved" : "demo-refusal",
    nonce: Date.now().toString(),
    treasuryAccountId: treasuryAccountId.toString(),
    recipientAllowlist: [allowedRecipientAccountId.toString()],
    maxAmountTinybars: MANDATE_CAP_TINYBARS,
    validFromEpochSeconds: (nowEpochSeconds - 60).toString(),
    expiresAtEpochSeconds: (nowEpochSeconds + 3_600).toString(),
  };
  const signature = Buffer.from(
    ownerPrivateKey.sign(canonicalMandateBytes(mandate)),
  ).toString("base64url");
  const envelope = parseMandateEnvelope({ mandate, signature });
  if (!verifyMandateSignature(envelope, ownerPrivateKey.publicKey)) {
    throw new Error("owner mandate signature verification failed");
  }

  return envelope;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(GUARD_PORT, GUARD_HOST, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error == null ? resolveClose() : reject(error)));
  });
}

function requirePaymentQuote(paymentRequired: PaymentRequired, payTo: string) {
  if (paymentRequired.accepts.length !== 1) {
    throw new Error("guard must return exactly one x402 payment option");
  }
  const quote = paymentRequired.accepts[0];
  if (
    quote.scheme !== "exact" ||
    quote.network !== HEDERA_TESTNET ||
    quote.asset !== HBAR_ASSET_ID ||
    quote.amount !== REVIEW_PRICE_TINYBARS ||
    quote.payTo !== payTo
  ) {
    throw new Error("x402 quote does not match the expected review payment");
  }

  return quote;
}

export async function runLiveFlow(outcome: LiveFlowOutcome): Promise<void> {
  const environment = loadEnvironment();
  const operatorAccountId = AccountId.fromString(environment.operatorAccountId);
  if (operatorAccountId.toString() !== environment.operatorAccountId) {
    throw new Error(
      "HEDERA_OPERATOR_ACCOUNT_ID must be a canonical numeric account ID",
    );
  }
  const operatorPrivateKey = PrivateKey.fromStringDer(
    environment.operatorPrivateKey,
  );
  const operatorClient = Client.forTestnet().setOperator(
    operatorAccountId,
    operatorPrivateKey,
  );
  let agentClient: Client | null = null;
  let guardClient: Client | null = null;
  let server: Server | null = null;
  const temporaryAccounts: TemporaryAccount[] = [];
  const cleanupFailures: Error[] = [];
  let primaryFailure: { readonly error: unknown } | null = null;

  try {
    const title =
      outcome === "approved"
        ? "COUNTERSIGN: ALLOWED TRANSFER"
        : "COUNTERSIGN: OUT-OF-POLICY TRANSFER";
    console.log(`\n${title}\n`);

    const versionInfo = await new NetworkVersionInfoQuery().execute(
      operatorClient,
    );
    const protobufVersion = formatVersion(versionInfo.protobufVersion);
    const servicesVersion = formatVersion(versionInfo.servicesVersion);
    console.log(
      "[1/7] Verify the live network and provision the authorization boundary",
    );
    console.log(`  HAPI protobuf version: ${protobufVersion}`);
    console.log(`  Services version: ${servicesVersion}`);
    if (protobufVersion !== environment.allowedProtobufVersion) {
      throw new Error(
        `network protobuf version ${protobufVersion} does not match the reviewed version ${environment.allowedProtobufVersion}`,
      );
    }
    if (servicesVersion !== environment.allowedServicesVersion) {
      throw new Error(
        `network services version ${servicesVersion} does not match the reviewed version ${environment.allowedServicesVersion}`,
      );
    }

    const ownerPrivateKey = PrivateKey.generateED25519();
    const agentPrivateKey = PrivateKey.generateED25519();
    const guardPrivateKey = PrivateKey.generateED25519();
    const paymentPayerPrivateKey = PrivateKey.generateED25519();
    const treasuryKey = new KeyList(
      [
        ownerPrivateKey.publicKey,
        new KeyList([agentPrivateKey.publicKey, guardPrivateKey.publicKey], 2),
      ],
      1,
    );

    const treasuryAccountId = await createAccount(
      operatorClient,
      treasuryKey,
      TREASURY_INITIAL_BALANCE_TINYBARS,
      "Treasury account",
    );
    temporaryAccounts.push({
      accountId: treasuryAccountId,
      privateKey: ownerPrivateKey,
      label: "Treasury account",
    });
    const agentAccountId = await createAccount(
      operatorClient,
      agentPrivateKey.publicKey,
      AGENT_INITIAL_BALANCE_TINYBARS,
      "Agent account",
    );
    temporaryAccounts.push({
      accountId: agentAccountId,
      privateKey: agentPrivateKey,
      label: "Agent account",
    });
    const guardAccountId = await createAccount(
      operatorClient,
      guardPrivateKey.publicKey,
      GUARD_INITIAL_BALANCE_TINYBARS,
      "Guard account",
    );
    temporaryAccounts.push({
      accountId: guardAccountId,
      privateKey: guardPrivateKey,
      label: "Guard account",
    });
    const paymentPayerAccountId = await createAccount(
      operatorClient,
      paymentPayerPrivateKey.publicKey,
      PAYMENT_PAYER_INITIAL_BALANCE_TINYBARS,
      "x402 payer account",
    );
    temporaryAccounts.push({
      accountId: paymentPayerAccountId,
      privateKey: paymentPayerPrivateKey,
      label: "x402 payer account",
    });
    agentClient = Client.forTestnet().setOperator(
      agentAccountId,
      agentPrivateKey,
    );
    guardClient = Client.forTestnet().setOperator(
      guardAccountId,
      guardPrivateKey,
    );
    console.log("  Authorization: 1-of[owner, 2-of[agent, guard]]");
    console.log(
      `  Agent public key: ${agentPrivateKey.publicKey.toStringRaw()}`,
    );
    console.log(
      `  Guard public key: ${guardPrivateKey.publicKey.toStringRaw()}`,
    );

    const nowEpochSeconds = Math.floor(Date.now() / 1_000);
    const envelope = buildMandate(
      outcome,
      ownerPrivateKey,
      treasuryAccountId,
      operatorAccountId,
      nowEpochSeconds,
    );
    const digest = mandateDigest(envelope.mandate);
    console.log("\n[2/7] Owner-signed mandate");
    console.log(
      JSON.stringify({ ...envelope, mandateDigest: digest }, null, 2),
    );

    const recipientAccountId =
      outcome === "approved" ? operatorAccountId : paymentPayerAccountId;
    const treasuryBefore = await queryTinybarBalance(
      operatorClient,
      treasuryAccountId,
    );
    const scheduleId = await createHbarSchedule(
      agentClient,
      treasuryAccountId,
      recipientAccountId,
      agentAccountId,
      digest,
      Timestamp.fromDate(new Date((nowEpochSeconds + 1_800) * 1_000)),
    );
    const scheduleUrl = scheduleMirrorNodeUrl(scheduleId);
    const expectedEvidence: ExpectedScheduleEvidence = {
      expectedAgentAccountId: agentAccountId.toString(),
      agentPublicKeyHex: agentPrivateKey.publicKey.toStringRaw(),
      guardPublicKeyHex: guardPrivateKey.publicKey.toStringRaw(),
    };
    console.log("\n[3/7] Agent publishes a scheduled transfer");
    console.log(`  ScheduleID: ${scheduleId.toString()}`);
    console.log(`  Recipient: ${recipientAccountId.toString()}`);
    console.log(`  Amount: ${TRANSFER_TINYBARS} tinybars`);
    console.log(`  Evidence: ${scheduleUrl}`);
    const pendingEvidence = await fetchScheduleEvidence(scheduleId);
    assertPendingScheduleEvidence(pendingEvidence, expectedEvidence);
    printScheduleEvidence(pendingEvidence);
    console.log(
      "  The agent signature is present, but the schedule is unexecuted.",
    );

    mkdirSync(resolve("var"), { recursive: true });
    server = await createProductionReviewServer(guardClient, {
      tenantId: envelope.mandate.tenantId,
      ownerPublicKey: ownerPrivateKey.publicKey,
      agentPublicKey: agentPrivateKey.publicKey,
      guardPublicKey: guardPrivateKey.publicKey,
      expectedAgentAccountId: agentAccountId.toString(),
      treasuryAccountId: treasuryAccountId.toString(),
      protocolMaxFeeTinybars: PROTOCOL_MAX_FEE_TINYBARS,
      allowedNetworkVersions: {
        protobuf: environment.allowedProtobufVersion,
        services: environment.allowedServicesVersion,
      },
      replayDatabasePath: resolve(
        "var",
        `demo-${outcome}-${Date.now()}.sqlite`,
      ),
      payment: {
        resourceUrl: GUARD_URL,
        priceTinybars: REVIEW_PRICE_TINYBARS,
        operationalAccount: {
          accountId: operatorAccountId.toString(),
          publicKey: operatorPrivateKey.publicKey,
        },
      },
      participantIdentities: {
        agent: {
          registry: "countersign",
          name: "Countersign Agent",
          version: "0.1.0",
          protocol: "hcs-10",
          nativeId: `hedera:testnet:${agentAccountId.toString()}`,
          skills: [],
        },
        guard: {
          registry: "countersign",
          name: "Countersign Guard",
          version: "0.1.0",
          protocol: "hcs-10",
          nativeId: `hedera:testnet:${guardAccountId.toString()}`,
          skills: [],
        },
      },
      reviewObserver: {
        onPaymentSettled(settlementId) {
          console.log(`  Settlement confirmed: ${settlementId}`);
          console.log(
            "\n[6/7] Guard resolves consensus and reviews every protected field",
          );
        },
        onReviewCheck(check) {
          console.log(
            `  ${check.passed ? "PASS" : "REFUSED"}: ${check.invariant}`,
          );
        },
      },
    });
    await listen(server);

    const reviewRequest = {
      tenantId: envelope.mandate.tenantId,
      mandateEnvelope: envelope,
      scheduleId: scheduleId.toString(),
    };
    console.log("\n[4/7] Caller requests guard review without payment");
    const challengeResponse = await fetch(GUARD_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(reviewRequest),
    });
    const challengeBody = (await challengeResponse.json()) as unknown;
    if (challengeResponse.status !== 402) {
      throw new Error(
        `guard did not return the required 402 challenge: HTTP ${challengeResponse.status}`,
      );
    }

    const payer = new x402Client()
      .register(
        HEDERA_TESTNET,
        new ExactHederaScheme(
          createClientHederaSigner(
            paymentPayerAccountId.toString(),
            paymentPayerPrivateKey,
            {
              network: HEDERA_TESTNET,
            },
          ),
        ),
      )
      .setSpendControls({
        allowedAssets: [
          {
            network: HEDERA_TESTNET,
            asset: HBAR_ASSET_ID,
            maxAmountPerPayment: REVIEW_PRICE_TINYBARS,
          },
        ],
      });
    const httpPayer = new x402HTTPClient(payer);
    const paymentRequired = httpPayer.getPaymentRequiredResponse(
      (name) => challengeResponse.headers.get(name),
      challengeBody,
    );
    const quote = requirePaymentQuote(
      paymentRequired,
      operatorAccountId.toString(),
    );
    console.log("  HTTP 402 Payment Required");
    console.log(`  Quote: ${quote.amount} tinybars`);
    console.log(`  Network: ${quote.network}`);
    console.log(`  Pay to: ${quote.payTo}`);
    console.log(`  Account evidence: ${accountMirrorNodeUrl(quote.payTo)}`);

    console.log("\n[5/7] Caller settles the x402 review price");
    const paymentPayload =
      await httpPayer.createPaymentPayload(paymentRequired);
    const paidResponse = await fetch(GUARD_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...httpPayer.encodePaymentSignatureHeader(paymentPayload),
      },
      body: JSON.stringify(reviewRequest),
    });
    const paidBody = (await paidResponse.json()) as unknown;
    if (!paidResponse.ok) {
      throw new Error(
        `paid guard review failed with HTTP ${paidResponse.status}`,
      );
    }
    const settlement = httpPayer.getPaymentSettleResponse((name) =>
      paidResponse.headers.get(name),
    );
    if (!settlement.success) {
      throw new Error(
        `x402 settlement failed: ${settlement.errorReason ?? "unknown reason"}`,
      );
    }
    const reviewResponse = parseReviewResponse(paidBody);
    if (reviewResponse.settlementId !== settlement.transaction) {
      throw new Error("guard settlement ID does not match the x402 response");
    }
    if (reviewResponse.scheduleId !== scheduleId.toString()) {
      throw new Error("guard response ScheduleID does not match the proposal");
    }
    if (reviewResponse.mandateDigest !== digest) {
      throw new Error(
        "guard response mandate digest does not match the mandate",
      );
    }

    console.log("\n[7/7] Independent outcome evidence");
    if (outcome === "approved") {
      if (reviewResponse.outcome !== "approved") {
        throw new Error(
          `allowed transfer was refused: ${reviewResponse.reason}`,
        );
      }
      if (
        reviewResponse.recipientAccountId !== operatorAccountId.toString() ||
        reviewResponse.amountTinybars !== TRANSFER_TINYBARS
      ) {
        throw new Error("guard approval does not match the mandated transfer");
      }
      console.log("  Review outcome: APPROVED");
      console.log("  Guard signature: submitted after exact policy approval");
      const executedEvidence = await waitForExecutedScheduleEvidence(
        scheduleId,
        expectedEvidence,
      );
      printScheduleEvidence(executedEvidence);
      const treasuryAfter = await queryTinybarBalance(
        operatorClient,
        treasuryAccountId,
      );
      const delta = treasuryBefore - treasuryAfter;
      if (delta !== BigInt(TRANSFER_TINYBARS)) {
        throw new Error(
          "treasury balance delta does not equal the approved amount",
        );
      }
      console.log(`  Schedule evidence: ${scheduleUrl}`);
      console.log(`  Treasury before: ${treasuryBefore.toString()} tinybars`);
      console.log(`  Treasury after:  ${treasuryAfter.toString()} tinybars`);
      console.log(`  Balance delta:   ${delta.toString()} tinybars`);
      console.log(
        `  Account evidence: ${accountMirrorNodeUrl(treasuryAccountId)}`,
      );
      console.log(`  Verdict evidence: ${reviewResponse.mirrorNodeUrl}`);
    } else {
      if (reviewResponse.outcome !== "refused") {
        throw new Error("out-of-policy recipient received guard approval");
      }
      if (
        reviewResponse.reason !== "recipient is outside the mandate allowlist"
      ) {
        throw new Error(
          `guard refused for an unexpected reason: ${reviewResponse.reason}`,
        );
      }
      console.log(`  Review outcome: REFUSED: ${reviewResponse.reason}`);
      console.log("  Guard signature: not submitted");
      const refusedEvidence = await fetchScheduleEvidence(scheduleId);
      assertPendingScheduleEvidence(refusedEvidence, expectedEvidence);
      printScheduleEvidence(refusedEvidence);
      const treasuryAfter = await queryTinybarBalance(
        operatorClient,
        treasuryAccountId,
      );
      if (treasuryAfter !== treasuryBefore) {
        throw new Error("treasury balance changed after the guard refusal");
      }
      console.log(`  Schedule evidence: ${scheduleUrl}`);
      console.log(`  Treasury before: ${treasuryBefore.toString()} tinybars`);
      console.log(`  Treasury after:  ${treasuryAfter.toString()} tinybars`);
      console.log(
        `  Account evidence: ${accountMirrorNodeUrl(treasuryAccountId)}`,
      );
      console.log(`  Verdict evidence: ${reviewResponse.mirrorNodeUrl}`);
    }

    // Record the run as an evidence event. These are operator-run reliability
    // exercises, never users, so origin is always operator.
    const eventDirectory = resolve("var", "evidence-events");
    mkdirSync(eventDirectory, { recursive: true });
    writeFileSync(
      resolve(eventDirectory, `${scheduleId.toString()}.json`),
      `${JSON.stringify(
        {
          kind: "review",
          guardPublicKeyPrefix: guardPrivateKey.publicKey.toStringRaw(),
          origin: "operator",
          scheduleId: scheduleId.toString(),
          outcome: reviewResponse.outcome,
          decidingInvariant:
            reviewResponse.outcome === "approved"
              ? "every protected field matched the owner-signed mandate"
              : reviewResponse.reason,
          mandateDigest: digest,
          mandatePolicy: {
            asset: { kind: "hbar" },
            recipientAllowlist: envelope.mandate.recipientAllowlist,
            maxAmountTinybars: envelope.mandate.maxAmountTinybars,
            validFromEpochSeconds: envelope.mandate.validFromEpochSeconds,
            expiresAtEpochSeconds: envelope.mandate.expiresAtEpochSeconds,
          },
          settlementId: settlement.transaction,
          settlementAmountTinybars: REVIEW_PRICE_TINYBARS,
          paymentPayerAccountId: paymentPayerAccountId.toString(),
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `  Evidence event: ${resolve(eventDirectory, `${scheduleId.toString()}.json`)}`,
    );
  } catch (error) {
    primaryFailure = { error };
  } finally {
    if (server?.listening) {
      try {
        await close(server);
      } catch (error) {
        recordCleanupFailure(
          cleanupFailures,
          "guard server close failed",
          error,
        );
      }
    }
    if (temporaryAccounts.length > 0) {
      console.log(
        "\nCleanup: return temporary account balances to the operator",
      );
    }
    for (const account of temporaryAccounts) {
      try {
        await recoverTemporaryBalance(
          operatorClient,
          operatorAccountId,
          account.accountId,
          account.privateKey,
          account.label,
        );
      } catch (error) {
        recordCleanupFailure(
          cleanupFailures,
          `${account.label} balance recovery failed`,
          error,
        );
      }
    }
    try {
      guardClient?.close();
    } catch (error) {
      recordCleanupFailure(cleanupFailures, "guard client close failed", error);
    }
    try {
      agentClient?.close();
    } catch (error) {
      recordCleanupFailure(cleanupFailures, "agent client close failed", error);
    }
    try {
      operatorClient.close();
    } catch (error) {
      recordCleanupFailure(
        cleanupFailures,
        "operator client close failed",
        error,
      );
    }
  }

  if (primaryFailure !== null) {
    throw primaryFailure.error;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "one or more temporary account cleanup operations failed",
    );
  }
  if (outcome === "approved") {
    console.log(
      "\nAllowed transfer executed with the exact mandated balance delta; temporary balances were recovered afterward.",
    );
  } else {
    console.log(
      "\nGuard refused the out-of-policy recipient: no guard signature, the transfer never executed, and the treasury balance stayed unchanged during review. Temporary balances were recovered afterward.",
    );
  }
}
