import type { proto } from "@hiero-ledger/proto";
import { PublicKey, type ScheduleInfo } from "@hiero-ledger/sdk";

import { mandateDigest, type Mandate } from "./mandate.ts";

const SCHEDULABLE_TRANSACTION_VARIANTS = [
  "contractCall",
  "contractCreateInstance",
  "contractUpdateInstance",
  "contractDeleteInstance",
  "cryptoCreateAccount",
  "cryptoDelete",
  "cryptoTransfer",
  "cryptoUpdateAccount",
  "fileAppend",
  "fileCreate",
  "fileDelete",
  "fileUpdate",
  "systemDelete",
  "systemUndelete",
  "freeze",
  "consensusCreateTopic",
  "consensusUpdateTopic",
  "consensusDeleteTopic",
  "consensusSubmitMessage",
  "tokenCreation",
  "tokenFreeze",
  "tokenUnfreeze",
  "tokenGrantKyc",
  "tokenRevokeKyc",
  "tokenDeletion",
  "tokenUpdate",
  "tokenMint",
  "tokenBurn",
  "tokenWipe",
  "tokenAssociate",
  "tokenDissociate",
  "scheduleDelete",
  "tokenPause",
  "tokenUnpause",
  "cryptoApproveAllowance",
  "cryptoDeleteAllowance",
  "tokenFeeScheduleUpdate",
  "utilPrng",
  "tokenUpdateNfts",
  "nodeCreate",
  "nodeUpdate",
  "nodeDelete",
  "tokenReject",
  "tokenCancelAirdrop",
  "tokenClaimAirdrop",
  "tokenAirdrop",
  "registeredNodeCreate",
  "registeredNodeUpdate",
  "registeredNodeDelete",
] as const satisfies readonly (keyof proto.ISchedulableTransactionBody)[];

const SCHEDULABLE_BODY_FIELDS = new Set<string>([
  "transactionFee",
  "memo",
  "maxCustomFees",
  ...SCHEDULABLE_TRANSACTION_VARIANTS,
]);
const CRYPTO_TRANSFER_FIELDS = new Set(["transfers", "tokenTransfers"]);
const TRANSFER_LIST_FIELDS = new Set(["accountAmounts"]);
const BALANCE_ADJUSTMENT_FIELDS = new Set([
  "accountID",
  "amount",
  "isApproval",
  "preTxAllowanceHook",
  "prePostTxAllowanceHook",
]);
const ACCOUNT_ID_FIELDS = new Set(["shardNum", "realmNum", "accountNum", "alias"]);

interface SemanticVersionTriple {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface ReviewContext {
  readonly requestedScheduleId: string;
  readonly expectedAgentAccountId: string;
  readonly treasuryAccountId: string;
  readonly agentPublicKey: PublicKey;
  readonly guardPublicKey: PublicKey;
  readonly protocolMaxFeeTinybars: string;
  readonly nowEpochSeconds: string;
  readonly networkVersions: {
    readonly protobuf: SemanticVersionTriple;
    readonly services: SemanticVersionTriple;
  };
  readonly allowedNetworkVersions: {
    readonly protobuf: string;
    readonly services: string;
  };
}

export type ReviewableScheduleInfo = Pick<
  ScheduleInfo,
  | "scheduleId"
  | "creatorAccountId"
  | "payerAccountId"
  | "schedulableTransactionBody"
  | "signers"
  | "scheduleMemo"
  | "adminKey"
  | "expirationTime"
  | "executed"
  | "deleted"
  | "waitForExpiry"
>;

export type ReviewOutcome =
  | {
      readonly approved: true;
      readonly recipientAccountId: string;
      readonly amountTinybars: string;
    }
  | { readonly approved: false; readonly reason: string };

function refusal(reason: string): ReviewOutcome {
  return { approved: false, reason };
}

function formatVersion(version: SemanticVersionTriple): string | null {
  if (
    !Number.isSafeInteger(version.major) ||
    !Number.isSafeInteger(version.minor) ||
    !Number.isSafeInteger(version.patch) ||
    version.major < 0 ||
    version.minor < 0 ||
    version.patch < 0
  ) {
    return null;
  }

  return `${version.major}.${version.minor}.${version.patch}`;
}

function integerValue(value: { toString(): string } | null | undefined): bigint | null {
  if (value == null) {
    return null;
  }

  const text = value.toString();
  if (!/^-?(0|[1-9][0-9]*)$/.test(text)) {
    return null;
  }

  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function unsupportedField(
  value: object,
  allowedFields: ReadonlySet<string>,
): string | null {
  return Object.keys(value).find((field) => !allowedFields.has(field)) ?? null;
}

function numericAccountId(accountId: proto.IAccountID | null | undefined): string | null {
  if (accountId == null) {
    return null;
  }

  if (unsupportedField(accountId, ACCOUNT_ID_FIELDS) != null) {
    return null;
  }

  if (accountId.alias != null || accountId.accountNum == null) {
    return null;
  }

  const shard = integerValue(accountId.shardNum);
  const realm = integerValue(accountId.realmNum);
  const account = integerValue(accountId.accountNum);
  if (shard == null || realm == null || account == null) {
    return null;
  }
  if (shard < 0n || realm < 0n || account < 0n) {
    return null;
  }

  return `${shard}.${realm}.${account}`;
}

function includesPublicKey(
  signers: ReviewableScheduleInfo["signers"],
  expected: PublicKey,
): boolean {
  if (signers == null) {
    return false;
  }

  return signers.toArray().some(
    (key) => key instanceof PublicKey && key.equals(expected),
  );
}

export function reviewSchedule(
  info: ReviewableScheduleInfo,
  mandate: Mandate,
  context: ReviewContext,
): ReviewOutcome {
  const protobufVersion = formatVersion(context.networkVersions.protobuf);
  if (protobufVersion !== context.allowedNetworkVersions.protobuf) {
    return refusal("network protobuf version is not approved for this validator");
  }
  const servicesVersion = formatVersion(context.networkVersions.services);
  if (servicesVersion !== context.allowedNetworkVersions.services) {
    return refusal("network services version is not approved for this validator");
  }

  if (info.scheduleId.toString() !== context.requestedScheduleId) {
    return refusal("returned ScheduleID does not match the requested ScheduleID");
  }
  if (info.creatorAccountId?.toString() !== context.expectedAgentAccountId) {
    return refusal("schedule creator is not the expected agent account");
  }
  if (info.payerAccountId?.toString() !== context.expectedAgentAccountId) {
    return refusal("scheduled transaction payer is not the expected agent account");
  }
  if (mandate.treasuryAccountId !== context.treasuryAccountId) {
    return refusal("mandate treasury does not match the configured treasury account");
  }

  const expectedDigest = mandateDigest(mandate);
  if (info.scheduleMemo !== expectedDigest) {
    return refusal("schedule memo is not bound to the mandate digest");
  }
  if (info.adminKey != null) {
    return refusal("schedule must not have an admin key");
  }
  if (info.waitForExpiry) {
    return refusal("schedule waitForExpiry must be false");
  }
  if (info.executed != null) {
    return refusal("schedule has already executed");
  }
  if (info.deleted != null) {
    return refusal("schedule has been deleted");
  }

  const now = integerValue({ toString: () => context.nowEpochSeconds });
  const validFrom = integerValue({ toString: () => mandate.validFromEpochSeconds });
  const expiresAt = integerValue({ toString: () => mandate.expiresAtEpochSeconds });
  if (now == null || validFrom == null || expiresAt == null) {
    return refusal("review time or mandate validity is invalid");
  }
  if (now < validFrom) {
    return refusal("mandate is not yet valid");
  }
  if (now >= expiresAt) {
    return refusal("mandate is expired");
  }
  const scheduleExpiration = integerValue(info.expirationTime?.seconds);
  const scheduleExpirationNanos = integerValue(info.expirationTime?.nanos);
  if (
    scheduleExpiration == null ||
    scheduleExpirationNanos == null ||
    scheduleExpirationNanos < 0n ||
    scheduleExpirationNanos >= 1_000_000_000n
  ) {
    return refusal("schedule expiration is missing or invalid");
  }
  if (
    scheduleExpiration > expiresAt ||
    (scheduleExpiration === expiresAt && scheduleExpirationNanos > 0n)
  ) {
    return refusal("schedule expiration exceeds mandate validity");
  }

  if (!includesPublicKey(info.signers, context.agentPublicKey)) {
    return refusal("agent key is absent from the schedule signers");
  }
  if (includesPublicKey(info.signers, context.guardPublicKey)) {
    return refusal("guard key is already present in the schedule signers");
  }

  const schedulableBody = info.schedulableTransactionBody;
  if (schedulableBody == null) {
    return refusal("schedulable body is missing");
  }
  const unsupportedBodyField = unsupportedField(
    schedulableBody,
    SCHEDULABLE_BODY_FIELDS,
  );
  if (unsupportedBodyField != null) {
    return refusal(`unsupported schedulable-body field: ${unsupportedBodyField}`);
  }

  const populatedVariants = SCHEDULABLE_TRANSACTION_VARIANTS.filter(
    (field) => schedulableBody[field] != null,
  );
  if (
    populatedVariants.length !== 1 ||
    populatedVariants[0] !== "cryptoTransfer"
  ) {
    return refusal("schedulable body must contain exactly one cryptoTransfer variant");
  }

  const transactionFee = integerValue(schedulableBody.transactionFee);
  const expectedFee = integerValue({
    toString: () => context.protocolMaxFeeTinybars,
  });
  if (transactionFee == null || expectedFee == null || transactionFee !== expectedFee) {
    return refusal("transaction fee does not equal the fixed protocol value");
  }
  if (schedulableBody.memo !== expectedDigest) {
    return refusal("transaction memo is not bound to the mandate digest");
  }
  if (schedulableBody.maxCustomFees == null || schedulableBody.maxCustomFees.length !== 0) {
    return refusal("maxCustomFees must be empty");
  }

  const cryptoTransfer = schedulableBody.cryptoTransfer;
  if (cryptoTransfer == null) {
    return refusal("cryptoTransfer body is missing");
  }
  const unsupportedCryptoField = unsupportedField(
    cryptoTransfer,
    CRYPTO_TRANSFER_FIELDS,
  );
  if (unsupportedCryptoField != null) {
    return refusal(`unsupported crypto-transfer field: ${unsupportedCryptoField}`);
  }
  if (cryptoTransfer.tokenTransfers == null || cryptoTransfer.tokenTransfers.length !== 0) {
    return refusal("token transfers must be empty");
  }

  const transferList = cryptoTransfer.transfers;
  if (transferList == null) {
    return refusal("HBAR transfer list is missing");
  }
  const unsupportedTransferListField = unsupportedField(
    transferList,
    TRANSFER_LIST_FIELDS,
  );
  if (unsupportedTransferListField != null) {
    return refusal(
      `unsupported HBAR transfer-list field: ${unsupportedTransferListField}`,
    );
  }
  const adjustments = transferList.accountAmounts;
  if (adjustments == null || adjustments.length !== 2) {
    return refusal("HBAR transfer must contain exactly two balance adjustments");
  }

  const parsedAdjustments: { accountId: string; amount: bigint }[] = [];
  for (const adjustment of adjustments) {
    const unsupportedAdjustmentField = unsupportedField(
      adjustment,
      BALANCE_ADJUSTMENT_FIELDS,
    );
    if (unsupportedAdjustmentField != null) {
      return refusal(
        `unsupported balance-adjustment field: ${unsupportedAdjustmentField}`,
      );
    }
    if (adjustment.isApproval !== false) {
      return refusal("balance adjustment isApproval must be false");
    }
    if (
      adjustment.preTxAllowanceHook != null ||
      adjustment.prePostTxAllowanceHook != null
    ) {
      return refusal("balance adjustment must not contain an allowance hook");
    }
    if (
      adjustment.accountID != null &&
      unsupportedField(adjustment.accountID, ACCOUNT_ID_FIELDS) != null
    ) {
      return refusal("unsupported account-ID field in balance adjustment");
    }
    const accountId = numericAccountId(adjustment.accountID);
    if (accountId == null) {
      return refusal("balance adjustment must use a numeric account ID without an alias");
    }
    const amount = integerValue(adjustment.amount);
    if (amount == null) {
      return refusal("balance adjustment amount is invalid");
    }
    parsedAdjustments.push({ accountId, amount });
  }

  const treasuryAdjustment = parsedAdjustments.find(
    ({ accountId }) => accountId === context.treasuryAccountId,
  );
  if (treasuryAdjustment == null) {
    return refusal("HBAR transfer does not contain the required treasury debit");
  }
  const recipientAdjustment = parsedAdjustments.find(
    ({ accountId }) => accountId !== context.treasuryAccountId,
  );
  if (recipientAdjustment == null) {
    return refusal("HBAR transfer does not contain exactly one recipient");
  }
  if (treasuryAdjustment.amount >= 0n || recipientAdjustment.amount <= 0n) {
    return refusal("transfer amount must be positive");
  }
  if (-treasuryAdjustment.amount !== recipientAdjustment.amount) {
    return refusal("treasury debit and recipient credit must be equal and opposite");
  }
  if (!mandate.recipientAllowlist.includes(recipientAdjustment.accountId)) {
    return refusal("recipient is outside the mandate allowlist");
  }
  const mandateCap = integerValue({ toString: () => mandate.maxAmountTinybars });
  if (mandateCap == null || recipientAdjustment.amount > mandateCap) {
    return refusal("transfer amount exceeds mandate cap");
  }

  return {
    approved: true,
    recipientAccountId: recipientAdjustment.accountId,
    amountTinybars: recipientAdjustment.amount.toString(),
  };
}
