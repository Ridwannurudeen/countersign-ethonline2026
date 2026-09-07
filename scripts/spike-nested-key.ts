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
  ReceiptStatusError,
  ScheduleCreateTransaction,
  ScheduleId,
  ScheduleInfoQuery,
  ScheduleSignTransaction,
  Status,
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
import { reviewSchedule, type ReviewContext } from "../src/review-schedule.ts";

const PROTOCOL_MAX_FEE_TINYBARS = "100000000";
const TREASURY_INITIAL_BALANCE_TINYBARS = "2000000000";
const AGENT_INITIAL_BALANCE_TINYBARS = "500000000";
const GUARD_INITIAL_BALANCE_TINYBARS = "200000000";
const MANDATE_CAP_TINYBARS = "50000000";
const APPROVED_TRANSFER_TINYBARS = "25000000";
const MIRROR_SCHEDULE_BASE_URL =
  "https://testnet.mirrornode.hedera.com/api/v1/schedules";

interface TemporaryAccount {
  readonly accountId: AccountId;
  readonly privateKey: PrivateKey;
  readonly label: string;
}

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
  console.log(`${label}: ${balance.toString()} tinybars recovered`);
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
  const temporaryAccounts: TemporaryAccount[] = [];
  const cleanupFailures: Error[] = [];
  let primaryFailure: { readonly error: unknown } | null = null;

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
    temporaryAccounts.push({
      accountId: treasuryAccountId,
      privateKey: ownerPrivateKey,
      label: "Treasury account",
    });
    const agentAccountId = await createAccount(
      operatorClient,
      agentPrivateKey.publicKey,
      AGENT_INITIAL_BALANCE_TINYBARS,
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
    );
    temporaryAccounts.push({
      accountId: guardAccountId,
      privateKey: guardPrivateKey,
      label: "Guard account",
    });

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

    const directTransferAmount = Hbar.fromTinybars(APPROVED_TRANSFER_TINYBARS);
    const agentOnlyDirectTransfer = new TransferTransaction()
      .addHbarTransfer(treasuryAccountId, directTransferAmount.negated())
      .addHbarTransfer(operatorAccountId, directTransferAmount)
      .setMaxTransactionFee(Hbar.fromTinybars(PROTOCOL_MAX_FEE_TINYBARS))
      .freezeWith(agentClient);
    await agentOnlyDirectTransfer.sign(agentPrivateKey);
    let agentOnlyDirectTransferRejected = false;
    try {
      const directTransferResponse = await agentOnlyDirectTransfer.execute(agentClient);
      await directTransferResponse.getReceipt(agentClient);
    } catch (error) {
      if (
        error instanceof ReceiptStatusError &&
        error.status === Status.InvalidSignature
      ) {
        agentOnlyDirectTransferRejected = true;
      } else {
        throw new Error(
          "agent-only direct transfer failed for an unexpected reason",
          { cause: error },
        );
      }
    }
    if (!agentOnlyDirectTransferRejected) {
      throw new Error("agent-only direct transfer unexpectedly executed");
    }
    console.log("Agent-only direct transfer rejected with INVALID_SIGNATURE");

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

    const signResponse = await new ScheduleSignTransaction()
      .setScheduleId(approvedScheduleId)
      .execute(guardClient);
    await signResponse.getReceipt(guardClient);

    const approvedScheduleAfterGuard = await querySchedule(
      operatorClient,
      approvedScheduleId,
    );
    if (approvedScheduleAfterGuard.executed == null) {
      throw new Error("approved schedule did not execute after the guard signature");
    }
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

  } catch (error) {
    primaryFailure = { error };
  } finally {
    if (temporaryAccounts.length > 0) {
      console.log("Cleanup: return temporary account balances to the operator");
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
      recordCleanupFailure(cleanupFailures, "operator client close failed", error);
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
  console.log("Owner-only recovery branch executed successfully");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Countersign Day-1 spike failed: ${message}`);
  process.exitCode = 1;
});
