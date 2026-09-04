import assert from "node:assert/strict";
import test from "node:test";

import { KeyList, PrivateKey } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";

import { mandateDigest, type Mandate } from "../src/mandate.ts";
import {
  reviewSchedule,
  type ReviewCheck,
  type ReviewContext,
  type ReviewableScheduleInfo,
} from "../src/review-schedule.ts";

const agentKey = PrivateKey.generateED25519().publicKey;
const guardKey = PrivateKey.generateED25519().publicKey;
const ownerKey = PrivateKey.generateED25519().publicKey;

const NON_CRYPTO_TRANSFER_VARIANTS = [
  "contractCall",
  "contractCreateInstance",
  "contractUpdateInstance",
  "contractDeleteInstance",
  "cryptoCreateAccount",
  "cryptoDelete",
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

const mandate: Mandate = {
  tenantId: "treasury-1",
  nonce: "7",
  treasuryAccountId: "0.0.1001",
  recipientAllowlist: ["0.0.1002"],
  maxAmountTinybars: "50000000",
  validFromEpochSeconds: "1788508800",
  expiresAtEpochSeconds: "1788512400",
};

const digest = mandateDigest(mandate);

const baseContext: ReviewContext = {
  requestedScheduleId: "0.0.7001",
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

function body(
  overrides: Record<string, unknown> = {},
): proto.ISchedulableTransactionBody {
  return {
    transactionFee: BigInt(baseContext.protocolMaxFeeTinybars),
    memo: digest,
    cryptoTransfer: {
      transfers: {
        accountAmounts: [
          adjustment("1001", "-25000000"),
          adjustment("1002", "25000000"),
        ],
      },
      tokenTransfers: [],
    },
    maxCustomFees: [],
    ...overrides,
  } as unknown as proto.ISchedulableTransactionBody;
}

function schedule(
  overrides: Record<string, unknown> = {},
): ReviewableScheduleInfo {
  return {
    scheduleId: { toString: () => "0.0.7001" },
    creatorAccountId: { toString: () => "0.0.2001" },
    payerAccountId: { toString: () => "0.0.2001" },
    schedulableTransactionBody: body(),
    signers: new KeyList([agentKey]),
    scheduleMemo: digest,
    adminKey: null,
    expirationTime: { seconds: BigInt("1788512000"), nanos: BigInt(0) },
    executed: null,
    deleted: null,
    waitForExpiry: false,
    ...overrides,
  } as unknown as ReviewableScheduleInfo;
}

function assertRefusal(
  info: ReviewableScheduleInfo,
  reason: RegExp,
  context: ReviewContext = baseContext,
): void {
  const outcome = reviewSchedule(info, mandate, context);
  assert.equal(outcome.approved, false);
  if (outcome.approved) {
    assert.fail("expected review refusal");
  }
  assert.match(outcome.reason, reason);
}

test("reviewSchedule approves a complete in-policy HBAR schedule", () => {
  assert.deepEqual(reviewSchedule(schedule(), mandate, baseContext), {
    approved: true,
    recipientAccountId: "0.0.1002",
    amountTinybars: "25000000",
  });
});

test("reviewSchedule reports its ordered invariant results", () => {
  const checks: ReviewCheck[] = [];

  const outcome = reviewSchedule(schedule(), mandate, baseContext, (check) => {
    checks.push(check);
  });

  assert.equal(outcome.approved, true);
  assert.ok(checks.length > 30);
  assert.equal(checks.every((check) => check.passed), true);
  assert.deepEqual(checks[0], {
    invariant: "network protobuf version is approved",
    passed: true,
  });
  assert.deepEqual(checks.at(-1), {
    invariant: "transfer amount is within the mandate cap",
    passed: true,
  });
});

test("reviewSchedule approves the installed protobuf decoder representation", () => {
  const decodedBody = proto.SchedulableTransactionBody.decode(
    proto.SchedulableTransactionBody.encode({
      transactionFee: 100000000,
      memo: digest,
      cryptoTransfer: {
        transfers: {
          accountAmounts: [
            {
              accountID: { shardNum: 0, realmNum: 0, accountNum: 1001 },
              amount: -25000000,
              isApproval: false,
            },
            {
              accountID: { shardNum: 0, realmNum: 0, accountNum: 1002 },
              amount: 25000000,
              isApproval: false,
            },
          ],
        },
        tokenTransfers: [],
      },
      maxCustomFees: [],
    } as unknown as proto.ISchedulableTransactionBody).finish(),
  );

  const outcome = reviewSchedule(
    schedule({ schedulableTransactionBody: decodedBody }),
    mandate,
    baseContext,
  );

  assert.equal(outcome.approved, true, outcome.approved ? undefined : outcome.reason);
});

test("reviewSchedule refuses a returned ScheduleID different from the request", () => {
  assertRefusal(schedule({ scheduleId: { toString: () => "0.0.7002" } }), /ScheduleID/);
});

test("reviewSchedule refuses a creator other than the expected agent", () => {
  assertRefusal(
    schedule({ creatorAccountId: { toString: () => "0.0.2002" } }),
    /creator/,
  );
});

test("reviewSchedule refuses a payer other than the expected agent", () => {
  assertRefusal(
    schedule({ payerAccountId: { toString: () => "0.0.2002" } }),
    /payer/,
  );
});

test("reviewSchedule refuses a mandate for a different treasury", () => {
  assertRefusal(schedule(), /mandate treasury/, {
    ...baseContext,
    treasuryAccountId: "0.0.1004",
  });
});

test("reviewSchedule refuses an outer memo not bound to the mandate digest", () => {
  assertRefusal(schedule({ scheduleMemo: "different" }), /schedule memo/);
});

test("reviewSchedule refuses a mutable schedule with an admin key", () => {
  assertRefusal(schedule({ adminKey: ownerKey }), /admin key/);
});

test("reviewSchedule refuses waitForExpiry", () => {
  assertRefusal(schedule({ waitForExpiry: true }), /waitForExpiry/);
});

test("reviewSchedule refuses a missing expiration", () => {
  assertRefusal(schedule({ expirationTime: null }), /expiration/);
});

test("reviewSchedule refuses expiration beyond mandate validity", () => {
  assertRefusal(
    schedule({
      expirationTime: { seconds: BigInt("1788512401"), nanos: BigInt(0) },
    }),
    /expiration exceeds mandate validity/,
  );
});

test("reviewSchedule refuses sub-second expiration beyond mandate validity", () => {
  assertRefusal(
    schedule({
      expirationTime: {
        seconds: BigInt(mandate.expiresAtEpochSeconds),
        nanos: BigInt(1),
      },
    }),
    /expiration exceeds mandate validity/,
  );
});

test("reviewSchedule refuses an expired mandate", () => {
  assertRefusal(schedule(), /mandate is expired/, {
    ...baseContext,
    nowEpochSeconds: mandate.expiresAtEpochSeconds,
  });
});

test("reviewSchedule refuses a mandate that is not yet valid", () => {
  assertRefusal(schedule(), /mandate is not yet valid/, {
    ...baseContext,
    nowEpochSeconds: "1788508799",
  });
});

test("reviewSchedule refuses an already executed schedule", () => {
  assertRefusal(
    schedule({ executed: { seconds: BigInt("1788509000"), nanos: BigInt(0) } }),
    /executed/,
  );
});

test("reviewSchedule refuses a deleted schedule", () => {
  assertRefusal(
    schedule({ deleted: { seconds: BigInt("1788509000"), nanos: BigInt(0) } }),
    /deleted/,
  );
});

test("reviewSchedule refuses when the agent signature is absent", () => {
  assertRefusal(schedule({ signers: new KeyList() }), /agent key/);
});

test("reviewSchedule refuses when the signer list is absent", () => {
  assertRefusal(schedule({ signers: null }), /agent key/);
});

test("reviewSchedule refuses when the guard has already signed", () => {
  assertRefusal(schedule({ signers: new KeyList([agentKey, guardKey]) }), /guard key/);
});

test("reviewSchedule refuses a protobuf network-version change", () => {
  assertRefusal(schedule(), /protobuf version/, {
    ...baseContext,
    networkVersions: {
      ...baseContext.networkVersions,
      protobuf: { major: 0, minor: 65, patch: 0 },
    },
  });
});

test("reviewSchedule refuses a services network-version change", () => {
  assertRefusal(schedule(), /services version/, {
    ...baseContext,
    networkVersions: {
      ...baseContext.networkVersions,
      services: { major: 0, minor: 65, patch: 0 },
    },
  });
});

test("reviewSchedule refuses a missing schedulable body", () => {
  assertRefusal(schedule({ schedulableTransactionBody: null }), /schedulable body/);
});

for (const variant of NON_CRYPTO_TRANSFER_VARIANTS) {
  test(`reviewSchedule refuses the ${variant} transaction variant`, () => {
    assertRefusal(
      schedule({
        schedulableTransactionBody: body({
          cryptoTransfer: undefined,
          [variant]: {},
        }),
      }),
      /exactly one cryptoTransfer variant/,
    );
  });
}

test("reviewSchedule refuses multiple transaction variants", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({ consensusSubmitMessage: {} }),
    }),
    /exactly one cryptoTransfer variant/,
  );
});

test("reviewSchedule refuses a transaction fee different from the protocol value", () => {
  assertRefusal(
    schedule({ schedulableTransactionBody: body({ transactionFee: BigInt(1) }) }),
    /transaction fee/,
  );
});

test("reviewSchedule refuses an inner memo not bound to the mandate digest", () => {
  assertRefusal(
    schedule({ schedulableTransactionBody: body({ memo: "different" }) }),
    /transaction memo/,
  );
});

test("reviewSchedule refuses maximum custom fees", () => {
  assertRefusal(
    schedule({ schedulableTransactionBody: body({ maxCustomFees: [{}] }) }),
    /maxCustomFees/,
  );
});

test("reviewSchedule refuses additional schedulable-body fields", () => {
  assertRefusal(
    schedule({ schedulableTransactionBody: body({ untrustedInstruction: true }) }),
    /unsupported schedulable-body field/,
  );
});

test("reviewSchedule refuses a missing HBAR transfer list", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: { transfers: null, tokenTransfers: [] },
      }),
    }),
    /HBAR transfer list/,
  );
});

test("reviewSchedule refuses token transfers", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: { transfers: { accountAmounts: [] }, tokenTransfers: [{}] },
      }),
    }),
    /token transfers/,
  );
});

test("reviewSchedule refuses additional crypto-transfer fields", () => {
  const cryptoTransfer = body().cryptoTransfer;
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: { ...cryptoTransfer, untrustedInstruction: true },
      }),
    }),
    /unsupported crypto-transfer field/,
  );
});

test("reviewSchedule refuses additional transfer-list fields", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: { accountAmounts: [], untrustedInstruction: true },
          tokenTransfers: [],
        },
      }),
    }),
    /unsupported HBAR transfer-list field/,
  );
});

test("reviewSchedule refuses an extra balance adjustment", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: {
            accountAmounts: [
              adjustment("1001", "-25000000"),
              adjustment("1002", "25000000"),
              adjustment("1003", "0"),
            ],
          },
          tokenTransfers: [],
        },
      }),
    }),
    /exactly two balance adjustments/,
  );
});

test("reviewSchedule refuses fewer than two balance adjustments", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: { accountAmounts: [adjustment("1001", "-25000000")] },
          tokenTransfers: [],
        },
      }),
    }),
    /exactly two balance adjustments/,
  );
});

test("reviewSchedule refuses a treasury adjustment that is not the debit", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: {
            accountAmounts: [
              adjustment("1003", "-25000000"),
              adjustment("1002", "25000000"),
            ],
          },
          tokenTransfers: [],
        },
      }),
    }),
    /treasury debit/,
  );
});

test("reviewSchedule refuses a recipient outside the allowlist", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: {
            accountAmounts: [
              adjustment("1001", "-25000000"),
              adjustment("1003", "25000000"),
            ],
          },
          tokenTransfers: [],
        },
      }),
    }),
    /recipient is outside the mandate allowlist/,
  );
});

test("reviewSchedule refuses an amount above the mandate cap", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: {
            accountAmounts: [
              adjustment("1001", "-50000001"),
              adjustment("1002", "50000001"),
            ],
          },
          tokenTransfers: [],
        },
      }),
    }),
    /amount exceeds mandate cap/,
  );
});

test("reviewSchedule refuses a non-positive amount", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: {
            accountAmounts: [adjustment("1001", "0"), adjustment("1002", "0")],
          },
          tokenTransfers: [],
        },
      }),
    }),
    /amount must be positive/,
  );
});

test("reviewSchedule refuses unequal balance adjustments", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: {
            accountAmounts: [
              adjustment("1001", "-25000000"),
              adjustment("1002", "24000000"),
            ],
          },
          tokenTransfers: [],
        },
      }),
    }),
    /equal and opposite/,
  );
});

for (const index of [0, 1]) {
  test(`reviewSchedule refuses isApproval on adjustment ${index + 1}`, () => {
    const accountAmounts = [
      adjustment("1001", "-25000000"),
      adjustment("1002", "25000000"),
    ];
    accountAmounts[index] = adjustment(
      index === 0 ? "1001" : "1002",
      index === 0 ? "-25000000" : "25000000",
      { isApproval: true },
    );
    assertRefusal(
      schedule({
        schedulableTransactionBody: body({
          cryptoTransfer: {
            transfers: { accountAmounts },
            tokenTransfers: [],
          },
        }),
      }),
      /isApproval/,
    );
  });
}

for (const hookField of ["preTxAllowanceHook", "prePostTxAllowanceHook"] as const) {
  test(`reviewSchedule refuses ${hookField}`, () => {
    assertRefusal(
      schedule({
        schedulableTransactionBody: body({
          cryptoTransfer: {
            transfers: {
              accountAmounts: [
                adjustment("1001", "-25000000", { [hookField]: {} }),
                adjustment("1002", "25000000"),
              ],
            },
            tokenTransfers: [],
          },
        }),
      }),
      /allowance hook/,
    );
  });
}

test("reviewSchedule refuses alias account identifiers", () => {
  const accountID = {
    shardNum: BigInt(0),
    realmNum: BigInt(0),
    alias: new Uint8Array([1]),
  } as unknown as proto.IAccountID;
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: {
            accountAmounts: [
              adjustment("1001", "-25000000", { accountID }),
              adjustment("1002", "25000000"),
            ],
          },
          tokenTransfers: [],
        },
      }),
    }),
    /numeric account ID/,
  );
});

test("reviewSchedule refuses additional account-identifier fields", () => {
  const accountID = {
    ...numericAccount("1001"),
    untrustedInstruction: true,
  } as unknown as proto.IAccountID;
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: {
            accountAmounts: [
              adjustment("1001", "-25000000", { accountID }),
              adjustment("1002", "25000000"),
            ],
          },
          tokenTransfers: [],
        },
      }),
    }),
    /unsupported account-ID field/,
  );
});

test("reviewSchedule refuses additional balance-adjustment fields", () => {
  assertRefusal(
    schedule({
      schedulableTransactionBody: body({
        cryptoTransfer: {
          transfers: {
            accountAmounts: [
              adjustment("1001", "-25000000", { untrustedInstruction: true }),
              adjustment("1002", "25000000"),
            ],
          },
          tokenTransfers: [],
        },
      }),
    }),
    /unsupported balance-adjustment field/,
  );
});
