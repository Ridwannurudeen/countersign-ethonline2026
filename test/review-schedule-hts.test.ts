import assert from "node:assert/strict";
import test from "node:test";

import { KeyList, PrivateKey } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";

import {
  mandateDigest,
  parseMandateEnvelope,
  type Mandate,
} from "../src/mandate.ts";
import {
  reviewSchedule,
  type ReviewContext,
  type ReviewableScheduleInfo,
} from "../src/review-schedule.ts";

const agentKey = PrivateKey.generateED25519().publicKey;
const guardKey = PrivateKey.generateED25519().publicKey;

const baseMandateFields = {
  tenantId: "treasury-1",
  nonce: "8",
  treasuryAccountId: "0.0.1001",
  recipientAllowlist: ["0.0.1002"],
  maxAmountTinybars: "50000000",
  validFromEpochSeconds: "1788508800",
  expiresAtEpochSeconds: "1788512400",
};

function versionTwoMandate(asset: unknown): Mandate {
  return {
    schemaVersion: "2",
    asset,
    ...baseMandateFields,
  } as unknown as Mandate;
}

const hbarMandate = versionTwoMandate({ kind: "hbar" });
const tokenMandate = versionTwoMandate({
  kind: "hts",
  tokenId: "0.0.7001",
});

const baseContext: ReviewContext = {
  requestedScheduleId: "0.0.8001",
  expectedAgentAccountId: "0.0.2001",
  treasuryAccountId: "0.0.1001",
  agentPublicKey: agentKey,
  guardPublicKey: guardKey,
  protocolMaxFeeTinybars: "100000000",
  nowEpochSeconds: "1788509000",
  networkVersions: {
    protobuf: { major: 0, minor: 64, patch: 0 },
    services: { major: 0, minor: 64, patch: 0 },
  },
  allowedNetworkVersions: {
    protobuf: "0.64.0",
    services: "0.64.0",
  },
};

function numericAccount(accountNum: string): proto.IAccountID {
  return {
    shardNum: BigInt(0),
    realmNum: BigInt(0),
    accountNum: BigInt(accountNum),
  } as unknown as proto.IAccountID;
}

function numericToken(tokenNum: string): proto.ITokenID {
  return {
    shardNum: BigInt(0),
    realmNum: BigInt(0),
    tokenNum: BigInt(tokenNum),
  } as unknown as proto.ITokenID;
}

function adjustment(
  accountNum: string,
  amount: string,
  overrides: Record<string, unknown> = {},
): proto.IAccountAmount {
  return {
    accountID: numericAccount(accountNum),
    amount: BigInt(amount),
    isApproval: false,
    ...overrides,
  } as unknown as proto.IAccountAmount;
}

function tokenTransfer(
  overrides: Record<string, unknown> = {},
): proto.ITokenTransferList {
  return {
    token: numericToken("7001"),
    transfers: [
      adjustment("1001", "-25000000"),
      adjustment("1002", "25000000"),
    ],
    nftTransfers: [],
    expectedDecimals: null,
    ...overrides,
  } as unknown as proto.ITokenTransferList;
}

function body(
  mandate: Mandate,
  cryptoTransfer: proto.ICryptoTransferTransactionBody,
  overrides: Record<string, unknown> = {},
): proto.ISchedulableTransactionBody {
  return {
    transactionFee: BigInt(baseContext.protocolMaxFeeTinybars),
    memo: mandateDigest(mandate),
    cryptoTransfer,
    maxCustomFees: [],
    ...overrides,
  } as unknown as proto.ISchedulableTransactionBody;
}

function schedule(
  mandate: Mandate,
  cryptoTransfer: proto.ICryptoTransferTransactionBody,
  bodyOverrides: Record<string, unknown> = {},
): ReviewableScheduleInfo {
  const digest = mandateDigest(mandate);
  return {
    scheduleId: { toString: () => "0.0.8001" },
    creatorAccountId: { toString: () => "0.0.2001" },
    payerAccountId: { toString: () => "0.0.2001" },
    schedulableTransactionBody: body(
      mandate,
      cryptoTransfer,
      bodyOverrides,
    ),
    signers: new KeyList([agentKey]),
    scheduleMemo: digest,
    adminKey: null,
    expirationTime: { seconds: BigInt("1788512000"), nanos: BigInt(0) },
    executed: null,
    deleted: null,
    waitForExpiry: false,
  } as unknown as ReviewableScheduleInfo;
}

function tokenCryptoTransfer(
  transfer: proto.ITokenTransferList = tokenTransfer(),
  hbarAdjustments: proto.IAccountAmount[] = [],
): proto.ICryptoTransferTransactionBody {
  return {
    transfers: { accountAmounts: hbarAdjustments },
    tokenTransfers: [transfer],
  };
}

function assertRefusal(
  mandate: Mandate,
  info: ReviewableScheduleInfo,
  reason: RegExp,
): void {
  const outcome = reviewSchedule(info, mandate, baseContext);
  assert.equal(outcome.approved, false);
  if (outcome.approved) {
    assert.fail("expected review refusal");
  }
  assert.match(outcome.reason, reason);
}

test("mandate schema v2 requires an explicit asset", () => {
  assert.throws(
    () =>
      parseMandateEnvelope({
        mandate: { schemaVersion: "2", ...baseMandateFields },
        signature: "A".repeat(86),
      }),
    /missing mandate field: asset/,
  );
});

test("mandate schema v2 refuses an ambiguous asset", () => {
  assert.throws(
    () =>
      parseMandateEnvelope({
        mandate: {
          schemaVersion: "2",
          asset: { kind: "hts" },
          ...baseMandateFields,
        },
        signature: "A".repeat(86),
      }),
    /tokenId/,
  );
});

test("mandate schema v2 normalizes an explicit HTS token ID", () => {
  const parsed = parseMandateEnvelope({
    mandate: {
      schemaVersion: "2",
      asset: { kind: "hts", tokenId: "00.000.007001" },
      ...baseMandateFields,
    },
    signature: "A".repeat(86),
  });

  assert.deepEqual(
    "asset" in parsed.mandate ? parsed.mandate.asset : undefined,
    { kind: "hts", tokenId: "0.0.7001" },
  );
});

test("reviewSchedule accepts an explicit schema-v2 HBAR mandate", () => {
  const info = schedule(hbarMandate, {
    transfers: {
      accountAmounts: [
        adjustment("1001", "-25000000"),
        adjustment("1002", "25000000"),
      ],
    },
    tokenTransfers: [],
  });

  assert.deepEqual(reviewSchedule(info, hbarMandate, baseContext), {
    approved: true,
    recipientAccountId: "0.0.1002",
    amountTinybars: "25000000",
  });
});

test("reviewSchedule refuses a token id different from the mandate asset", () => {
  assertRefusal(
    tokenMandate,
    schedule(
      tokenMandate,
      tokenCryptoTransfer(tokenTransfer({ token: numericToken("7002") })),
    ),
    /token ID does not match the mandate asset/,
  );
});

test("reviewSchedule refuses a token transfer when the mandate says HBAR", () => {
  assertRefusal(
    hbarMandate,
    schedule(hbarMandate, tokenCryptoTransfer()),
    /token transfers must be empty for an HBAR mandate/,
  );
});

test("reviewSchedule refuses an HBAR transfer when the mandate says HTS", () => {
  assertRefusal(
    tokenMandate,
    schedule(
      tokenMandate,
      tokenCryptoTransfer(tokenTransfer(), [
        adjustment("1001", "-1"),
        adjustment("1002", "1"),
      ]),
    ),
    /HBAR transfers must be empty for an HTS mandate/,
  );
});

test("reviewSchedule refuses both HBAR and token transfer lists populated", () => {
  assertRefusal(
    tokenMandate,
    schedule(
      tokenMandate,
      tokenCryptoTransfer(tokenTransfer(), [
        adjustment("1001", "-1"),
        adjustment("1002", "1"),
      ]),
    ),
    /HBAR transfers must be empty for an HTS mandate/,
  );
});

test("reviewSchedule refuses an over-cap token amount", () => {
  assertRefusal(
    tokenMandate,
    schedule(
      tokenMandate,
      tokenCryptoTransfer(
        tokenTransfer({
          transfers: [
            adjustment("1001", "-50000001"),
            adjustment("1002", "50000001"),
          ],
        }),
      ),
    ),
    /transfer amount exceeds mandate cap/,
  );
});

test("reviewSchedule refuses a token recipient outside the allowlist", () => {
  assertRefusal(
    tokenMandate,
    schedule(
      tokenMandate,
      tokenCryptoTransfer(
        tokenTransfer({
          transfers: [
            adjustment("1001", "-25000000"),
            adjustment("1003", "25000000"),
          ],
        }),
      ),
    ),
    /recipient is outside the mandate allowlist/,
  );
});

test("reviewSchedule refuses a third token balance adjustment", () => {
  assertRefusal(
    tokenMandate,
    schedule(
      tokenMandate,
      tokenCryptoTransfer(
        tokenTransfer({
          transfers: [
            adjustment("1001", "-25000000"),
            adjustment("1002", "20000000"),
            adjustment("1003", "5000000"),
          ],
        }),
      ),
    ),
    /token transfer must contain exactly two balance adjustments/,
  );
});

test("reviewSchedule refuses isApproval on a token adjustment", () => {
  assertRefusal(
    tokenMandate,
    schedule(
      tokenMandate,
      tokenCryptoTransfer(
        tokenTransfer({
          transfers: [
            adjustment("1001", "-25000000", { isApproval: true }),
            adjustment("1002", "25000000"),
          ],
        }),
      ),
    ),
    /isApproval/,
  );
});

for (const hookField of ["preTxAllowanceHook", "prePostTxAllowanceHook"] as const) {
  test(`reviewSchedule refuses ${hookField} on a token adjustment`, () => {
    assertRefusal(
      tokenMandate,
      schedule(
        tokenMandate,
        tokenCryptoTransfer(
          tokenTransfer({
            transfers: [
              adjustment("1001", "-25000000", { [hookField]: {} }),
              adjustment("1002", "25000000"),
            ],
          }),
        ),
      ),
      /allowance hook/,
    );
  });
}

test("reviewSchedule refuses maxCustomFees for an HTS transfer", () => {
  assertRefusal(
    tokenMandate,
    schedule(tokenMandate, tokenCryptoTransfer(), { maxCustomFees: [{}] }),
    /maxCustomFees/,
  );
});

test("reviewSchedule refuses structurally valid HTS until custom fees can be verified", () => {
  assertRefusal(
    tokenMandate,
    schedule(tokenMandate, tokenCryptoTransfer()),
    /HTS custom-fee state is not verified/,
  );
});
