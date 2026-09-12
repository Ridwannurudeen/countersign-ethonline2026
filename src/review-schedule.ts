import type { proto } from "@hiero-ledger/proto";
import { PublicKey, type ScheduleInfo } from "@hiero-ledger/sdk";

import { mandateAsset, mandateDigest, type Mandate } from "./mandate.ts";

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
const TOKEN_TRANSFER_LIST_FIELDS = new Set([
  "token",
  "transfers",
  "nftTransfers",
  "expectedDecimals",
]);
const BALANCE_ADJUSTMENT_FIELDS = new Set([
  "accountID",
  "amount",
  "isApproval",
  "preTxAllowanceHook",
  "prePostTxAllowanceHook",
]);
const ACCOUNT_ID_FIELDS = new Set(["shardNum", "realmNum", "accountNum", "alias"]);
const TOKEN_ID_FIELDS = new Set(["shardNum", "realmNum", "tokenNum"]);

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

export interface ReviewCheck {
  readonly invariant: string;
  readonly passed: boolean;
}

export type ReviewCheckReporter = (check: ReviewCheck) => void;

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

function numericTokenId(tokenId: proto.ITokenID | null | undefined): string | null {
  if (tokenId == null) {
    return null;
  }

  if (unsupportedField(tokenId, TOKEN_ID_FIELDS) != null) {
    return null;
  }

  const shard = integerValue(tokenId.shardNum);
  const realm = integerValue(tokenId.realmNum);
  const token = integerValue(tokenId.tokenNum);
  if (shard == null || realm == null || token == null) {
    return null;
  }
  if (shard < 0n || realm < 0n || token < 0n) {
    return null;
  }

  return `${shard}.${realm}.${token}`;
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
  reportCheck?: ReviewCheckReporter,
): ReviewOutcome {
  function check(
    invariant: string,
    passed: boolean,
    reason: string,
  ): ReviewOutcome | false {
    reportCheck?.({ invariant, passed });
    return passed ? false : refusal(reason);
  }

  let denialCase: ReviewOutcome | false;
  const protobufVersion = formatVersion(context.networkVersions.protobuf);
  denialCase = check(
    "network protobuf version is approved",
    protobufVersion === context.allowedNetworkVersions.protobuf,
    "network protobuf version is not approved for this validator",
  );
  if (denialCase !== false) return denialCase;
  const servicesVersion = formatVersion(context.networkVersions.services);
  denialCase = check(
    "network services version is approved",
    servicesVersion === context.allowedNetworkVersions.services,
    "network services version is not approved for this validator",
  );
  if (denialCase !== false) return denialCase;

  denialCase = check(
    "returned ScheduleID matches the requested ScheduleID",
    info.scheduleId.toString() === context.requestedScheduleId,
    "returned ScheduleID does not match the requested ScheduleID",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "schedule creator is the expected agent account",
    info.creatorAccountId?.toString() === context.expectedAgentAccountId,
    "schedule creator is not the expected agent account",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "scheduled transaction payer is the expected agent account",
    info.payerAccountId?.toString() === context.expectedAgentAccountId,
    "scheduled transaction payer is not the expected agent account",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "scheduled network fee is not paid by the treasury",
    context.expectedAgentAccountId !== context.treasuryAccountId,
    "scheduled network fee must not be paid by the treasury",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "mandate treasury matches the configured treasury account",
    mandate.treasuryAccountId === context.treasuryAccountId,
    "mandate treasury does not match the configured treasury account",
  );
  if (denialCase !== false) return denialCase;

  const expectedDigest = mandateDigest(mandate);
  denialCase = check(
    "schedule memo is bound to the mandate digest",
    info.scheduleMemo === expectedDigest,
    "schedule memo is not bound to the mandate digest",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "schedule has no admin key",
    info.adminKey == null,
    "schedule must not have an admin key",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "schedule waitForExpiry is false",
    !info.waitForExpiry,
    "schedule waitForExpiry must be false",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "schedule is not already executed",
    info.executed == null,
    "schedule has already executed",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "schedule is not deleted",
    info.deleted == null,
    "schedule has been deleted",
  );
  if (denialCase !== false) return denialCase;

  const now = integerValue({ toString: () => context.nowEpochSeconds });
  const validFrom = integerValue({ toString: () => mandate.validFromEpochSeconds });
  const expiresAt = integerValue({ toString: () => mandate.expiresAtEpochSeconds });
  if (now == null || validFrom == null || expiresAt == null) {
    reportCheck?.({
      invariant: "review time and mandate validity are valid integers",
      passed: false,
    });
    return refusal("review time or mandate validity is invalid");
  }
  reportCheck?.({
    invariant: "review time and mandate validity are valid integers",
    passed: true,
  });
  denialCase = check(
    "mandate validity has started",
    now >= validFrom,
    "mandate is not yet valid",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "mandate is not expired",
    now < expiresAt,
    "mandate is expired",
  );
  if (denialCase !== false) return denialCase;
  const scheduleExpiration = integerValue(info.expirationTime?.seconds);
  const scheduleExpirationNanos = integerValue(info.expirationTime?.nanos);
  if (
    scheduleExpiration == null ||
    scheduleExpirationNanos == null ||
    scheduleExpirationNanos < 0n ||
    scheduleExpirationNanos >= 1_000_000_000n
  ) {
    reportCheck?.({
      invariant: "schedule expiration is present and valid",
      passed: false,
    });
    return refusal("schedule expiration is missing or invalid");
  }
  reportCheck?.({
    invariant: "schedule expiration is present and valid",
    passed: true,
  });
  denialCase = check(
    "schedule expiration does not exceed mandate validity",
    scheduleExpiration < expiresAt ||
      (scheduleExpiration === expiresAt && scheduleExpirationNanos === 0n),
    "schedule expiration exceeds mandate validity",
  );
  if (denialCase !== false) return denialCase;

  denialCase = check(
    "agent key is present in the schedule signers",
    includesPublicKey(info.signers, context.agentPublicKey),
    "agent key is absent from the schedule signers",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "guard key is absent from the schedule signers",
    !includesPublicKey(info.signers, context.guardPublicKey),
    "guard key is already present in the schedule signers",
  );
  if (denialCase !== false) return denialCase;

  const schedulableBody = info.schedulableTransactionBody;
  if (schedulableBody == null) {
    reportCheck?.({
      invariant: "schedulable transaction body is present",
      passed: false,
    });
    return refusal("schedulable body is missing");
  }
  reportCheck?.({
    invariant: "schedulable transaction body is present",
    passed: true,
  });
  const unsupportedBodyField = unsupportedField(
    schedulableBody,
    SCHEDULABLE_BODY_FIELDS,
  );
  if (unsupportedBodyField != null) {
    reportCheck?.({
      invariant: "schedulable transaction body contains only reviewed fields",
      passed: false,
    });
    return refusal(`unsupported schedulable-body field: ${unsupportedBodyField}`);
  }
  reportCheck?.({
    invariant: "schedulable transaction body contains only reviewed fields",
    passed: true,
  });

  const populatedVariants = SCHEDULABLE_TRANSACTION_VARIANTS.filter(
    (field) => schedulableBody[field] != null,
  );
  denialCase = check(
    "schedulable body contains exactly one cryptoTransfer variant",
    populatedVariants.length === 1 &&
      populatedVariants[0] === "cryptoTransfer",
    "schedulable body must contain exactly one cryptoTransfer variant",
  );
  if (denialCase !== false) return denialCase;

  const transactionFee = integerValue(schedulableBody.transactionFee);
  const expectedFee = integerValue({
    toString: () => context.protocolMaxFeeTinybars,
  });
  denialCase = check(
    "transaction fee equals the fixed protocol value",
    transactionFee != null &&
      expectedFee != null &&
      transactionFee === expectedFee,
    "transaction fee does not equal the fixed protocol value",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "transaction memo is bound to the mandate digest",
    schedulableBody.memo === expectedDigest,
    "transaction memo is not bound to the mandate digest",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "maxCustomFees is empty",
    schedulableBody.maxCustomFees != null &&
      schedulableBody.maxCustomFees.length === 0,
    "maxCustomFees must be empty",
  );
  if (denialCase !== false) return denialCase;

  const cryptoTransfer = schedulableBody.cryptoTransfer;
  if (cryptoTransfer == null) {
    reportCheck?.({
      invariant: "cryptoTransfer body is present",
      passed: false,
    });
    return refusal("cryptoTransfer body is missing");
  }
  reportCheck?.({ invariant: "cryptoTransfer body is present", passed: true });
  const unsupportedCryptoField = unsupportedField(
    cryptoTransfer,
    CRYPTO_TRANSFER_FIELDS,
  );
  if (unsupportedCryptoField != null) {
    reportCheck?.({
      invariant: "cryptoTransfer body contains only reviewed fields",
      passed: false,
    });
    return refusal(`unsupported crypto-transfer field: ${unsupportedCryptoField}`);
  }
  reportCheck?.({
    invariant: "cryptoTransfer body contains only reviewed fields",
    passed: true,
  });
  const asset = mandateAsset(mandate);
  let adjustments: proto.IAccountAmount[] | null | undefined;
  let transferLabel: "HBAR" | "token";
  if (asset.kind === "hbar") {
    denialCase = check(
      "token transfers are empty for an HBAR mandate",
      cryptoTransfer.tokenTransfers != null &&
        cryptoTransfer.tokenTransfers.length === 0,
      "token transfers must be empty for an HBAR mandate",
    );
    if (denialCase !== false) return denialCase;

    const transferList = cryptoTransfer.transfers;
    if (transferList == null) {
      reportCheck?.({
        invariant: "HBAR transfer list is present",
        passed: false,
      });
      return refusal("HBAR transfer list is missing");
    }
    reportCheck?.({ invariant: "HBAR transfer list is present", passed: true });
    const unsupportedTransferListField = unsupportedField(
      transferList,
      TRANSFER_LIST_FIELDS,
    );
    if (unsupportedTransferListField != null) {
      reportCheck?.({
        invariant: "HBAR transfer list contains only reviewed fields",
        passed: false,
      });
      return refusal(
        `unsupported HBAR transfer-list field: ${unsupportedTransferListField}`,
      );
    }
    reportCheck?.({
      invariant: "HBAR transfer list contains only reviewed fields",
      passed: true,
    });
    adjustments = transferList.accountAmounts;
    transferLabel = "HBAR";
  } else {
    const hbarTransferList = cryptoTransfer.transfers;
    if (hbarTransferList != null) {
      const unsupportedTransferListField = unsupportedField(
        hbarTransferList,
        TRANSFER_LIST_FIELDS,
      );
      if (unsupportedTransferListField != null) {
        reportCheck?.({
          invariant: "empty HBAR transfer list contains only reviewed fields",
          passed: false,
        });
        return refusal(
          `unsupported HBAR transfer-list field: ${unsupportedTransferListField}`,
        );
      }
    }
    denialCase = check(
      "HBAR transfers are empty for an HTS mandate",
      hbarTransferList == null ||
        hbarTransferList.accountAmounts == null ||
        hbarTransferList.accountAmounts.length === 0,
      "HBAR transfers must be empty for an HTS mandate",
    );
    if (denialCase !== false) return denialCase;

    const tokenTransfers = cryptoTransfer.tokenTransfers;
    if (tokenTransfers == null || tokenTransfers.length !== 1) {
      reportCheck?.({
        invariant: "HTS transfer contains exactly one token transfer list",
        passed: false,
      });
      return refusal("HTS transfer must contain exactly one token transfer list");
    }
    reportCheck?.({
      invariant: "HTS transfer contains exactly one token transfer list",
      passed: true,
    });
    const tokenTransfer = tokenTransfers[0];
    if (tokenTransfer == null) {
      return refusal("HTS transfer must contain exactly one token transfer list");
    }
    const unsupportedTokenTransferField = unsupportedField(
      tokenTransfer,
      TOKEN_TRANSFER_LIST_FIELDS,
    );
    if (unsupportedTokenTransferField != null) {
      reportCheck?.({
        invariant: "token transfer list contains only reviewed fields",
        passed: false,
      });
      return refusal(
        `unsupported token transfer-list field: ${unsupportedTokenTransferField}`,
      );
    }
    reportCheck?.({
      invariant: "token transfer list contains only reviewed fields",
      passed: true,
    });
    denialCase = check(
      "token ID matches the mandate asset",
      numericTokenId(tokenTransfer.token) === asset.tokenId,
      "token ID does not match the mandate asset",
    );
    if (denialCase !== false) return denialCase;
    denialCase = check(
      "token transfer contains no NFT transfers",
      tokenTransfer.nftTransfers != null &&
        tokenTransfer.nftTransfers.length === 0,
      "token transfer must not contain NFT transfers",
    );
    if (denialCase !== false) return denialCase;
    denialCase = check(
      "token transfer does not set expectedDecimals",
      tokenTransfer.expectedDecimals == null,
      "token transfer expectedDecimals is outside the reviewed model",
    );
    if (denialCase !== false) return denialCase;
    adjustments = tokenTransfer.transfers;
    transferLabel = "token";
  }

  if (adjustments == null || adjustments.length !== 2) {
    reportCheck?.({
      invariant: `${transferLabel} transfer contains exactly two balance adjustments`,
      passed: false,
    });
    return refusal(
      `${transferLabel} transfer must contain exactly two balance adjustments`,
    );
  }
  reportCheck?.({
    invariant: `${transferLabel} transfer contains exactly two balance adjustments`,
    passed: true,
  });

  const parsedAdjustments: { accountId: string; amount: bigint }[] = [];
  for (const [index, adjustment] of adjustments.entries()) {
    const label = `balance adjustment ${index + 1}`;
    const unsupportedAdjustmentField = unsupportedField(
      adjustment,
      BALANCE_ADJUSTMENT_FIELDS,
    );
    if (unsupportedAdjustmentField != null) {
      reportCheck?.({
        invariant: `${label} contains only reviewed fields`,
        passed: false,
      });
      return refusal(
        `unsupported balance-adjustment field: ${unsupportedAdjustmentField}`,
      );
    }
    reportCheck?.({
      invariant: `${label} contains only reviewed fields`,
      passed: true,
    });
    if (adjustment.isApproval !== false) {
      reportCheck?.({
        invariant: `${label} isApproval is false`,
        passed: false,
      });
      return refusal("balance adjustment isApproval must be false");
    }
    reportCheck?.({
      invariant: `${label} isApproval is false`,
      passed: true,
    });
    if (
      adjustment.preTxAllowanceHook != null ||
      adjustment.prePostTxAllowanceHook != null
    ) {
      reportCheck?.({
        invariant: `${label} contains no allowance hook`,
        passed: false,
      });
      return refusal("balance adjustment must not contain an allowance hook");
    }
    reportCheck?.({
      invariant: `${label} contains no allowance hook`,
      passed: true,
    });
    if (
      adjustment.accountID != null &&
      unsupportedField(adjustment.accountID, ACCOUNT_ID_FIELDS) != null
    ) {
      reportCheck?.({
        invariant: `${label} account ID contains only reviewed fields`,
        passed: false,
      });
      return refusal("unsupported account-ID field in balance adjustment");
    }
    reportCheck?.({
      invariant: `${label} account ID contains only reviewed fields`,
      passed: true,
    });
    const accountId = numericAccountId(adjustment.accountID);
    if (accountId == null) {
      reportCheck?.({
        invariant: `${label} uses a numeric account ID without an alias`,
        passed: false,
      });
      return refusal("balance adjustment must use a numeric account ID without an alias");
    }
    reportCheck?.({
      invariant: `${label} uses a numeric account ID without an alias`,
      passed: true,
    });
    const amount = integerValue(adjustment.amount);
    if (amount == null) {
      reportCheck?.({
        invariant: `${label} amount is a valid integer`,
        passed: false,
      });
      return refusal("balance adjustment amount is invalid");
    }
    reportCheck?.({
      invariant: `${label} amount is a valid integer`,
      passed: true,
    });
    parsedAdjustments.push({ accountId, amount });
  }

  const treasuryAdjustment = parsedAdjustments.find(
    ({ accountId }) => accountId === context.treasuryAccountId,
  );
  if (treasuryAdjustment == null) {
    reportCheck?.({
      invariant: "HBAR transfer contains the required treasury debit",
      passed: false,
    });
    return refusal("HBAR transfer does not contain the required treasury debit");
  }
  reportCheck?.({
    invariant: "HBAR transfer contains the required treasury debit",
    passed: true,
  });
  const recipientAdjustment = parsedAdjustments.find(
    ({ accountId }) => accountId !== context.treasuryAccountId,
  );
  if (recipientAdjustment == null) {
    reportCheck?.({
      invariant: "HBAR transfer contains exactly one recipient",
      passed: false,
    });
    return refusal("HBAR transfer does not contain exactly one recipient");
  }
  reportCheck?.({
    invariant: "HBAR transfer contains exactly one recipient",
    passed: true,
  });
  denialCase = check(
    "treasury debit is negative and recipient credit is positive",
    treasuryAdjustment.amount < 0n && recipientAdjustment.amount > 0n,
    "transfer amount must be positive",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "treasury debit and recipient credit are equal and opposite",
    -treasuryAdjustment.amount === recipientAdjustment.amount,
    "treasury debit and recipient credit must be equal and opposite",
  );
  if (denialCase !== false) return denialCase;
  denialCase = check(
    "recipient is on the mandate allowlist",
    mandate.recipientAllowlist.includes(recipientAdjustment.accountId),
    "recipient is outside the mandate allowlist",
  );
  if (denialCase !== false) return denialCase;
  const mandateCap = integerValue({ toString: () => mandate.maxAmountTinybars });
  denialCase = check(
    "transfer amount is within the mandate cap",
    mandateCap != null && recipientAdjustment.amount <= mandateCap,
    "transfer amount exceeds mandate cap",
  );
  if (denialCase !== false) return denialCase;

  if (asset.kind === "hts") {
    reportCheck?.({
      invariant: "HTS custom-fee state is verified as empty and immutable",
      passed: false,
    });
    return refusal(
      "HTS custom-fee state is not verified; token transfers are refused",
    );
  }

  return {
    approved: true,
    recipientAccountId: recipientAdjustment.accountId,
    amountTinybars: recipientAdjustment.amount.toString(),
  };
}
