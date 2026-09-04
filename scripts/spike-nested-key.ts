import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  AccountBalanceQuery,
  AccountCreateTransaction,
  AccountId,
  AccountInfoQuery,
  Client,
  Hbar,
  KeyList,
  NetworkVersionInfoQuery,
  PrivateKey,
  PublicKey,
  ScheduleCreateTransaction,
  ScheduleId,
  ScheduleInfoQuery,
  ScheduleSignTransaction,
  Timestamp,
  TransferTransaction,
  type Key,
  type ScheduleInfo,
} from "@hiero-ledger/sdk";

import {
  canonicalMandateBytes,
  mandateDigest,
  parseMandateEnvelope,
  verifyMandateSignature,
  type Mandate,
} from "../src/mandate.ts";
import {
  completeMandateReview,
  reserveMandateReview,
  type MandateReviewReservation,
} from "../src/replay-store.ts";
import { reviewSchedule, type ReviewContext } from "../src/review-schedule.ts";

const PROTOCOL_MAX_FEE_TINYBARS = "100000000";
const TREASURY_INITIAL_BALANCE_TINYBARS = "2000000000";
const AGENT_INITIAL_BALANCE_TINYBARS = "500000000";
const GUARD_INITIAL_BALANCE_TINYBARS = "200000000";
const MANDATE_CAP_TINYBARS = "50000000";
const APPROVED_TRANSFER_TINYBARS = "25000000";
const MIRROR_SCHEDULE_BASE_URL =
  "https://testnet.mirrornode.hedera.com/api/v1/schedules";

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value == null || value.length === 0) {
    throw new Error(`missing required environment variable: ${name}`);
  }

  return value;
}

function requireVersion(name: string): string {
  const value = requireEnvironmentVariable(name);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a major.minor.patch version`);
  }

  return value;
}

async function createAccount(
  client: Client,
  key: Key,
  initialBalanceTinybars: string,
): Promise<AccountId> {
  const response = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key)
    .setInitialBalance(Hbar.fromTinybars(initialBalanceTinybars))
    .execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.accountId == null) {
    throw new Error("account creation receipt did not contain an account ID");
  }

  return receipt.accountId;
}

async function querySchedule(
  client: Client,
  scheduleId: ScheduleId,
): Promise<ScheduleInfo> {
  return new ScheduleInfoQuery().setScheduleId(scheduleId).execute(client);
}

async function queryTinybarBalance(
  client: Client,
  accountId: AccountId,
): Promise<bigint> {
  const balance = await new AccountBalanceQuery().setAccountId(accountId).execute(client);
  return BigInt(balance.hbars.toTinybars().toString());
}

async function createHbarSchedule(
  client: Client,
  treasuryAccountId: AccountId,
  recipientAccountId: AccountId,
  agentAccountId: AccountId,
  amountTinybars: string,
  digest: string,
  expirationTime: Timestamp,
): Promise<ScheduleId> {
  const amount = Hbar.fromTinybars(amountTinybars);
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

  console.log(`${MIRROR_SCHEDULE_BASE_URL}/${receipt.scheduleId.toString()}`);
  return receipt.scheduleId;
}

function formatVersion(version: {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function hasPublicKey(info: ScheduleInfo, publicKey: PublicKey): boolean {
  return (
    info.signers?.toArray().some(
      (signer) => signer instanceof PublicKey && signer.equals(publicKey),
    ) ?? false
  );
}

async function main(): Promise<void> {
  const operatorAccountId = AccountId.fromString(
    requireEnvironmentVariable("HEDERA_OPERATOR_ACCOUNT_ID"),
  );
  const operatorPrivateKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable("HEDERA_OPERATOR_PRIVATE_KEY"),
  );
  const operatorClient = Client.forTestnet().setOperator(
    operatorAccountId,
    operatorPrivateKey,
  );
  let agentClient: Client | null = null;
  let guardClient: Client | null = null;

  try {
    const versionInfo = await new NetworkVersionInfoQuery().execute(operatorClient);
    const protobufVersion = formatVersion(versionInfo.protobufVersion);
    const servicesVersion = formatVersion(versionInfo.servicesVersion);
    console.log(`HAPI protobuf version: ${protobufVersion}`);
    console.log(`Services version: ${servicesVersion}`);
    const allowedProtobufVersion = requireVersion(
      "COUNTERSIGN_ALLOWED_PROTOBUF_VERSION",
    );
    const allowedServicesVersion = requireVersion(
      "COUNTERSIGN_ALLOWED_SERVICES_VERSION",
    );
    if (protobufVersion !== allowedProtobufVersion) {
      throw new Error(
        `network protobuf version ${protobufVersion} does not match the reviewed version ${allowedProtobufVersion}`,
      );
    }
    if (servicesVersion !== allowedServicesVersion) {
      throw new Error(
        `network services version ${servicesVersion} does not match the reviewed version ${allowedServicesVersion}`,
      );
    }

    const ownerPrivateKey = PrivateKey.generateED25519();
    const agentPrivateKey = PrivateKey.generateED25519();
    const guardPrivateKey = PrivateKey.generateED25519();
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
    );
    const agentAccountId = await createAccount(
      operatorClient,
      agentPrivateKey.publicKey,
      AGENT_INITIAL_BALANCE_TINYBARS,
    );
    const guardAccountId = await createAccount(
      operatorClient,
      guardPrivateKey.publicKey,
      GUARD_INITIAL_BALANCE_TINYBARS,
    );

    agentClient = Client.forTestnet().setOperator(agentAccountId, agentPrivateKey);
    guardClient = Client.forTestnet().setOperator(guardAccountId, guardPrivateKey);

    const treasuryInfo = await new AccountInfoQuery()
      .setAccountId(treasuryAccountId)
      .execute(operatorClient);
    if (!(treasuryInfo.key instanceof KeyList) || treasuryInfo.key.threshold !== 1) {
      throw new Error("stored treasury key is not the required outer 1-of key list");
    }
    const outerKeys = treasuryInfo.key.toArray();
    if (
      outerKeys.length !== 2 ||
      !(outerKeys[0] instanceof PublicKey) ||
      !outerKeys[0].equals(ownerPrivateKey.publicKey) ||
      !(outerKeys[1] instanceof KeyList) ||
      outerKeys[1].threshold !== 2
    ) {
      throw new Error("stored treasury key branches do not match the required key tree");
    }
    const agentGuardKeys = outerKeys[1].toArray();
    if (
      agentGuardKeys.length !== 2 ||
      !(agentGuardKeys[0] instanceof PublicKey) ||
      !agentGuardKeys[0].equals(agentPrivateKey.publicKey) ||
      !(agentGuardKeys[1] instanceof PublicKey) ||
      !agentGuardKeys[1].equals(guardPrivateKey.publicKey)
    ) {
      throw new Error("stored nested key branch does not contain the agent and guard keys");
    }
    console.log(`Treasury key tree verified for ${treasuryAccountId.toString()}`);

    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const unparsedMandate: Mandate = {
      tenantId: "day1-proof",
      nonce: Date.now().toString(),
      treasuryAccountId: treasuryAccountId.toString(),
      recipientAllowlist: [operatorAccountId.toString()],
      maxAmountTinybars: MANDATE_CAP_TINYBARS,
      validFromEpochSeconds: (nowEpochSeconds - 60).toString(),
      expiresAtEpochSeconds: (nowEpochSeconds + 3600).toString(),
    };
    const mandateSignature = Buffer.from(
      ownerPrivateKey.sign(canonicalMandateBytes(unparsedMandate)),
    ).toString("base64url");
    const envelope = parseMandateEnvelope({
      mandate: unparsedMandate,
      signature: mandateSignature,
    });
    if (!verifyMandateSignature(envelope, ownerPrivateKey.publicKey)) {
      throw new Error("owner mandate signature verification failed");
    }
    const digest = mandateDigest(envelope.mandate);
    const expirationTime = Timestamp.fromDate(
      new Date((nowEpochSeconds + 1800) * 1000),
    );

    const reviewContextBase: Omit<ReviewContext, "requestedScheduleId"> = {
      expectedAgentAccountId: agentAccountId.toString(),
      treasuryAccountId: treasuryAccountId.toString(),
      agentPublicKey: agentPrivateKey.publicKey,
      guardPublicKey: guardPrivateKey.publicKey,
      protocolMaxFeeTinybars: PROTOCOL_MAX_FEE_TINYBARS,
      nowEpochSeconds: Math.floor(Date.now() / 1000).toString(),
      networkVersions: {
        protobuf: versionInfo.protobufVersion,
        services: versionInfo.servicesVersion,
      },
      allowedNetworkVersions: {
        protobuf: allowedProtobufVersion,
        services: allowedServicesVersion,
      },
    };

    const treasuryBeforeApproval = await queryTinybarBalance(
      operatorClient,
      treasuryAccountId,
    );
    const approvedScheduleId = await createHbarSchedule(
      agentClient,
      treasuryAccountId,
      operatorAccountId,
      agentAccountId,
      APPROVED_TRANSFER_TINYBARS,
      digest,
      expirationTime,
    );
    const approvedScheduleBeforeGuard = await querySchedule(
      operatorClient,
      approvedScheduleId,
    );
    if (approvedScheduleBeforeGuard.executed != null) {
      throw new Error("agent-only schedule executed before guard approval");
    }
    if (
      !hasPublicKey(approvedScheduleBeforeGuard, agentPrivateKey.publicKey) ||
      hasPublicKey(approvedScheduleBeforeGuard, guardPrivateKey.publicKey)
    ) {
      throw new Error("pre-review signer set does not contain only the required approval state");
    }

    const approvedReview = reviewSchedule(
      approvedScheduleBeforeGuard,
      envelope.mandate,
      {
        ...reviewContextBase,
        requestedScheduleId: approvedScheduleId.toString(),
      },
    );
    if (!approvedReview.approved) {
      throw new Error(`in-policy schedule was refused: ${approvedReview.reason}`);
    }

    const databaseDirectory = resolve("var");
    mkdirSync(databaseDirectory, { recursive: true });
    const reservation: MandateReviewReservation = {
      tenantId: envelope.mandate.tenantId,
      nonce: envelope.mandate.nonce,
      mandateDigest: digest,
      scheduleId: approvedScheduleId.toString(),
    };
    const reservationResult = reserveMandateReview(
      resolve(databaseDirectory, "countersign.sqlite"),
      reservation,
    );
    if (reservationResult.status !== "reserved") {
      throw new Error(`mandate reservation did not create a new reservation: ${reservationResult.status}`);
    }

    const signResponse = await new ScheduleSignTransaction()
      .setScheduleId(approvedScheduleId)
      .execute(guardClient);
    await signResponse.getReceipt(guardClient);
    completeMandateReview(
      resolve(databaseDirectory, "countersign.sqlite"),
      reservation,
      "guardSignatureSubmitted",
    );

    const approvedScheduleAfterGuard = await querySchedule(
      operatorClient,
      approvedScheduleId,
    );
    if (approvedScheduleAfterGuard.executed == null) {
      throw new Error("approved schedule did not execute after the guard signature");
    }
    completeMandateReview(
      resolve(databaseDirectory, "countersign.sqlite"),
      reservation,
      "executionConfirmed",
    );
    const treasuryAfterApproval = await queryTinybarBalance(
      operatorClient,
      treasuryAccountId,
    );
    if (
      treasuryBeforeApproval - treasuryAfterApproval !==
      BigInt(APPROVED_TRANSFER_TINYBARS)
    ) {
      throw new Error("treasury balance delta does not equal the approved transfer amount");
    }
    console.log(`Approved schedule executed: ${approvedScheduleId.toString()}`);

    const outOfPolicyScheduleId = await createHbarSchedule(
      agentClient,
      treasuryAccountId,
      guardAccountId,
      agentAccountId,
      APPROVED_TRANSFER_TINYBARS,
      digest,
      expirationTime,
    );
    const outOfPolicyInfo = await querySchedule(
      operatorClient,
      outOfPolicyScheduleId,
    );
    const outOfPolicyReview = reviewSchedule(outOfPolicyInfo, envelope.mandate, {
      ...reviewContextBase,
      requestedScheduleId: outOfPolicyScheduleId.toString(),
    });
    if (outOfPolicyReview.approved) {
      throw new Error("recipient outside the mandate allowlist received approval");
    }
    if (
      outOfPolicyInfo.executed != null ||
      hasPublicKey(outOfPolicyInfo, guardPrivateKey.publicKey)
    ) {
      throw new Error("refused schedule changed the required non-executed signer state");
    }
    console.log(`Refused schedule remained unexecuted: ${outOfPolicyScheduleId.toString()}`);

    const treasuryBeforeRecovery = await queryTinybarBalance(
      operatorClient,
      treasuryAccountId,
    );
    const recoveryAmount = Hbar.fromTinybars(treasuryBeforeRecovery.toString());
    const recoveryTransaction = new TransferTransaction()
      .addHbarTransfer(treasuryAccountId, recoveryAmount.negated())
      .addHbarTransfer(operatorAccountId, recoveryAmount)
      .freezeWith(operatorClient);
    await recoveryTransaction.sign(ownerPrivateKey);
    const recoveryResponse = await recoveryTransaction.execute(operatorClient);
    await recoveryResponse.getReceipt(operatorClient);
    const treasuryAfterRecovery = await queryTinybarBalance(
      operatorClient,
      treasuryAccountId,
    );
    if (
      treasuryBeforeRecovery - treasuryAfterRecovery !==
      treasuryBeforeRecovery
    ) {
      throw new Error("owner recovery did not return the complete treasury balance");
    }
    console.log("Owner-only recovery branch executed successfully");
  } finally {
    guardClient?.close();
    agentClient?.close();
    operatorClient.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Countersign Day-1 spike failed: ${message}`);
  process.exitCode = 1;
});
