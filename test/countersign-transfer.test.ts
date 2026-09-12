import assert from "node:assert/strict";
import test from "node:test";

import { proto } from "@hiero-ledger/proto";
import {
  AccountId,
  Hbar,
  PrivateKey,
  Transaction,
  TransactionId,
  TokenId,
  TokenInfo,
  TokenInfoQuery,
  TransferTransaction,
} from "@hiero-ledger/sdk";

import { canonicalMandateBytes, type Mandate } from "../src/mandate.ts";
import {
  countersignTransfer,
  validateCountersignTransfer,
  type CountersignApproval,
  type CountersignContext,
} from "../src/countersign-transfer.ts";
import type { ReviewCheck } from "../src/review-schedule.ts";

const owner = PrivateKey.generateED25519();
const agent = PrivateKey.generateED25519();
const guard = PrivateKey.generateED25519();
const mandate: Mandate = {
  tenantId: "treasury-1",
  nonce: "7",
  treasuryAccountId: "0.0.1001",
  recipientAllowlist: ["0.0.1002"],
  maxAmountTinybars: "100",
  validFromEpochSeconds: "1788508800",
  expiresAtEpochSeconds: "1788512400",
};
const context: CountersignContext = {
  expectedAgentAccountId: "0.0.2001",
  treasuryAccountId: mandate.treasuryAccountId,
  ownerPublicKey: owner.publicKey,
  agentPublicKey: agent.publicKey,
  guardPublicKey: guard.publicKey,
  nowEpochSeconds: "1788509005",
  protocolMaxFeeTinybars: "100000000",
};

function envelope(value: Mandate = mandate) {
  return {
    mandate: value,
    signature: Buffer.from(owner.sign(canonicalMandateBytes(value))).toString(
      "base64url",
    ),
  };
}

async function fixture(key = agent, nodes = ["0.0.3"]) {
  const transaction = new TransferTransaction()
    .setTransactionId(TransactionId.fromString("0.0.4001@1788509000.000000000"))
    .setNodeAccountIds(nodes.map((node) => AccountId.fromString(node)))
    .setMaxTransactionFee(Hbar.fromTinybars(context.protocolMaxFeeTinybars))
    .addHbarTransfer("0.0.1001", Hbar.fromTinybars(-100))
    .addHbarTransfer("0.0.1002", Hbar.fromTinybars(100))
    .freeze();
  await transaction.sign(key);
  return Buffer.from(transaction.toBytes()).toString("base64");
}

function rewrite(
  bytes: string,
  edit: (
    body: proto.TransactionBody,
    signed: proto.SignedTransaction,
  ) => Uint8Array | void,
  resign = true,
): string {
  const list = proto.TransactionList.decode(Buffer.from(bytes, "base64"));
  const transaction = list.transactionList[0];
  const signed = proto.SignedTransaction.decode(
    transaction.signedTransactionBytes!,
  );
  const body = proto.TransactionBody.decode(signed.bodyBytes);
  signed.bodyBytes =
    edit(body, signed) ?? proto.TransactionBody.encode(body).finish();
  if (resign)
    signed.sigMap = {
      sigPair: [
        agent.publicKey._toProtobufSignature(agent.sign(signed.bodyBytes)),
      ],
    };
  transaction.signedTransactionBytes =
    proto.SignedTransaction.encode(signed).finish();
  return Buffer.from(proto.TransactionList.encode(list).finish()).toString(
    "base64",
  );
}

async function refused(
  bytes: string,
  invariant: string,
  policy = context,
  value = envelope(),
) {
  const checks: ReviewCheck[] = [];
  const result = await validateCountersignTransfer(
    bytes,
    value,
    policy,
    (check) => checks.push(check),
  );
  assert.deepEqual(result, { approved: false, reason: invariant, invariant });
  assert.deepEqual(checks.at(-1), { invariant, passed: false });
}

test("approves SDK-frozen agent-signed HBAR at the cap and preserves exact bytes when countersigning", async () => {
  const bytes = await fixture();
  const result = await validateCountersignTransfer(bytes, envelope(), context);
  assert.equal(result.approved, true, JSON.stringify(result));
  assert.ok(result.approved);
  assert.equal(result.amountTinybars, "100");
  assert.equal(result.recipientAccountId, "0.0.1002");
  assert.equal(result.agentAccountId, context.expectedAgentAccountId);
  assert.equal(result.treasuryAccountId, context.treasuryAccountId);
  assert.deepEqual(result.asset, { kind: "hbar" });
  assert.ok(Object.isFrozen(result));
  const output = countersignTransfer(result, guard);
  const before = proto.TransactionList.decode(Buffer.from(bytes, "base64"));
  const after = proto.TransactionList.decode(Buffer.from(output, "base64"));
  const original = proto.SignedTransaction.decode(
    before.transactionList[0].signedTransactionBytes!,
  );
  const signed = proto.SignedTransaction.decode(
    after.transactionList[0].signedTransactionBytes!,
  );
  assert.deepEqual(signed.bodyBytes, original.bodyBytes);
  assert.deepEqual(signed.sigMap!.sigPair![0], original.sigMap!.sigPair![0]);
  assert.equal(signed.sigMap!.sigPair!.length, 2);
  assert.ok(
    agent.publicKey.verify(
      signed.bodyBytes,
      signed.sigMap!.sigPair![0].ed25519!,
    ),
  );
  assert.ok(
    guard.publicKey.verify(
      signed.bodyBytes,
      signed.sigMap!.sigPair![1].ed25519!,
    ),
  );
  assert.ok(
    Transaction.fromBytes(Buffer.from(output, "base64")) instanceof
      TransferTransaction,
  );
  await refused(output, "guard signature is not already present");
});

test("re-encode equality refuses an unknown signed body field even with a valid agent signature", async () => {
  const bytes = rewrite(await fixture(), (body) =>
    Buffer.concat([
      proto.TransactionBody.encode(body).finish(),
      Buffer.from([0xf8, 0x7f, 0x01]),
    ]),
  );
  await refused(bytes, "signed body re-encode equality");
});

// The outermost envelope is checked too: a field the TransactionList schema does not model
// would otherwise be dropped by the decoder and never reach the inner checks.
test("re-encode equality refuses an unknown TransactionList field", async () => {
  const valid = Buffer.from(await fixture(), "base64");
  const bytes = Buffer.concat([
    valid,
    Buffer.from([0xf8, 0x7f, 0x01]),
  ]).toString("base64");
  await refused(bytes, "transaction list re-encode equality");
});

test("re-encode equality refuses an unknown nested transfer field", async () => {
  const bytes = rewrite(await fixture(), (body) => {
    const transfer = Buffer.concat([
      proto.CryptoTransferTransactionBody.encode(body.cryptoTransfer!).finish(),
      Buffer.from([0xf8, 0x7f, 0x01]),
    ]);
    body.cryptoTransfer = null;
    const writer = proto.TransactionBody.encode(body);
    return writer
      .uint32(14 * 8 + 2)
      .bytes(transfer)
      .finish();
  });
  await refused(bytes, "signed body re-encode equality");
});

const bodyCases: [string, (body: proto.TransactionBody) => void, string][] = [
  [
    "non-transfer operation",
    (body) => {
      body.cryptoTransfer = null;
      body.cryptoUpdateAccount = {};
    },
    "transaction is only a TransferTransaction with reviewed fields",
  ],
  [
    "second operation",
    (body) => {
      body.cryptoUpdateAccount = {};
    },
    "transaction is only a TransferTransaction with reviewed fields",
  ],
  [
    "batch key",
    (body) => {
      body.batchKey = { ed25519: agent.publicKey.toBytesRaw() };
    },
    "transaction is only a TransferTransaction with reviewed fields",
  ],
  [
    "treasury pays the network fee",
    (body) => {
      // the treasury's own account ID, taken from the debit side of the transfer
      body.transactionID!.accountID = {
        ...body.cryptoTransfer!.transfers!.accountAmounts![0]!.accountID,
      };
    },
    "network fee is not paid by the treasury",
  ],
  [
    "scheduled flag",
    (body) => {
      body.transactionID!.scheduled = true;
    },
    "transaction ID is a well-formed unscheduled transaction",
  ],
  [
    "nonce",
    (body) => {
      body.transactionID!.nonce = 1;
    },
    "transaction ID is a well-formed unscheduled transaction",
  ],
  [
    "unapproved fee",
    (body) => {
      body.transactionFee =
        body.cryptoTransfer!.transfers!.accountAmounts![1].amount!;
    },
    "transaction fee equals the fixed protocol value",
  ],
  [
    "missing duration",
    (body) => {
      body.transactionValidDuration = null;
    },
    "transaction validity fields are present and valid",
  ],
  [
    "wrong debit account",
    (body) => {
      body.cryptoTransfer!.transfers!.accountAmounts![0].accountID =
        body.nodeAccountID;
    },
    "only the treasury is debited and exactly one recipient is credited",
  ],
  [
    "extra recipient",
    (body) => {
      body.cryptoTransfer!.transfers!.accountAmounts!.push(
        body.cryptoTransfer!.transfers!.accountAmounts![1],
      );
    },
    "transfer contains exactly two balance adjustments",
  ],
  [
    "unequal amounts",
    (body) => {
      body.cryptoTransfer!.transfers!.accountAmounts![1].amount =
        body.transactionFee;
    },
    "treasury debit and recipient credit are equal and opposite",
  ],
  [
    "nonpositive recipient",
    (body) => {
      body.cryptoTransfer!.transfers!.accountAmounts![1].amount =
        body.cryptoTransfer!.transfers!.accountAmounts![0].amount;
    },
    "only the treasury is debited and exactly one recipient is credited",
  ],
  [
    "unlisted recipient",
    (body) => {
      body.cryptoTransfer!.transfers!.accountAmounts![1].accountID =
        body.nodeAccountID;
    },
    "recipient is on the mandate allowlist",
  ],
  [
    "allowance",
    (body) => {
      body.cryptoTransfer!.transfers!.accountAmounts![0].isApproval = true;
    },
    "balance adjustment contains no approval, hook or unreviewed fields",
  ],
  [
    "hook",
    (body) => {
      body.cryptoTransfer!.transfers!.accountAmounts![0].preTxAllowanceHook =
        {};
    },
    "balance adjustment contains no approval, hook or unreviewed fields",
  ],
  [
    "alias",
    (body) => {
      body.cryptoTransfer!.transfers!.accountAmounts![1].accountID = {
        alias: agent.publicKey.toBytesRaw(),
      };
    },
    "balance adjustment uses a numeric account ID",
  ],
  [
    "mixed asset",
    (body) => {
      body.cryptoTransfer!.tokenTransfers = [{ token: {} }];
    },
    "asset matches the HBAR mandate",
  ],
];
for (const [name, edit, invariant] of bodyCases) {
  test(`refuses ${name}`, async () =>
    await refused(rewrite(await fixture(), edit), invariant));
}

test("refuses transfers above the owner-signed cap", async () => {
  await refused(
    await fixture(),
    "transfer amount is within the mandate cap",
    context,
    envelope({ ...mandate, maxAmountTinybars: "99" }),
  );
});

test("requires the configured owner's signature and matching treasury", async () => {
  await refused(
    await fixture(),
    "mandate signature is valid for the configured owner",
    { ...context, ownerPublicKey: guard.publicKey },
  );
  await refused(
    await fixture(),
    "mandate treasury matches the configured treasury",
    context,
    envelope({ ...mandate, treasuryAccountId: "0.0.9999" }),
  );
});

test("refuses inactive and expired mandates", async () => {
  for (const nowEpochSeconds of ["1788508799", mandate.expiresAtEpochSeconds]) {
    await refused(await fixture(), "mandate is active at review time", {
      ...context,
      nowEpochSeconds,
    });
  }
});

test("default validity floor leaves headroom and refuses its boundary, expiry and future start", async () => {
  const bytes = await fixture();
  for (const nowEpochSeconds of ["1788509090", "1788509120", "1788508999"]) {
    await refused(
      bytes,
      "transaction has started and remaining validity exceeds the floor",
      { ...context, nowEpochSeconds },
    );
  }
  assert.ok(
    (
      await validateCountersignTransfer(bytes, envelope(), {
        ...context,
        nowEpochSeconds: "1788509089",
      })
    ).approved,
  );
  await refused(
    bytes,
    "transaction has started and remaining validity exceeds the floor",
    { ...context, minRemainingValiditySeconds: "115" },
  );
  assert.ok(
    (
      await validateCountersignTransfer(bytes, envelope(), {
        ...context,
        minRemainingValiditySeconds: "114",
      })
    ).approved,
  );
  for (const minRemainingValiditySeconds of ["0", "-1", "NaN"]) {
    await refused(
      bytes,
      "review time, validity floor and fee policy are valid integers",
      { ...context, minRemainingValiditySeconds },
    );
  }
});

test("refuses absent, wrong, truncated-prefix and invalid agent signatures", async () => {
  const bytes = await fixture();
  await refused(
    await fixture(owner),
    "only the configured agent signature is present",
  );
  await refused(
    rewrite(
      bytes,
      (_body, signed) => {
        signed.sigMap!.sigPair = [];
      },
      false,
    ),
    "only the configured agent signature is present",
  );
  await refused(
    rewrite(
      bytes,
      (_body, signed) => {
        signed.sigMap!.sigPair![0].pubKeyPrefix = agent.publicKey
          .toBytesRaw()
          .subarray(0, 8);
      },
      false,
    ),
    "only the configured agent signature is present",
  );
  await refused(
    rewrite(
      bytes,
      (_body, signed) => {
        signed.sigMap!.sigPair![0].ed25519 = new Uint8Array(64);
      },
      false,
    ),
    "agent signature verifies the exact signed body bytes",
  );
  await refused(
    rewrite(
      bytes,
      (body) => {
        body.memo = "altered after signing";
      },
      false,
    ),
    "agent signature verifies the exact signed body bytes",
  );
});

test("supports ECDSA agent and guard signatures", async () => {
  const ecAgent = PrivateKey.generateECDSA();
  const ecGuard = PrivateKey.generateECDSA();
  const result = await validateCountersignTransfer(
    await fixture(ecAgent),
    envelope(),
    {
      ...context,
      agentPublicKey: ecAgent.publicKey,
      guardPublicKey: ecGuard.publicKey,
    },
  );
  assert.ok(result.approved, JSON.stringify(result));
  const transaction = Transaction.fromBytes(
    Buffer.from(countersignTransfer(result, ecGuard), "base64"),
  );
  assert.ok(ecAgent.publicKey.verifyTransaction(transaction));
  assert.ok(ecGuard.publicKey.verifyTransaction(transaction));
});

test("validates and countersigns every node variant; refuses divergent signed bodies", async () => {
  const bytes = await fixture(agent, ["0.0.3", "0.0.4"]);
  const result = await validateCountersignTransfer(bytes, envelope(), context);
  assert.ok(result.approved, JSON.stringify(result));
  const signed = proto.TransactionList.decode(
    Buffer.from(countersignTransfer(result, guard), "base64"),
  );
  for (const entry of signed.transactionList) {
    const transaction = proto.SignedTransaction.decode(
      entry.signedTransactionBytes!,
    );
    assert.ok(
      guard.publicKey.verify(
        transaction.bodyBytes,
        transaction.sigMap!.sigPair![1].ed25519!,
      ),
    );
  }
  await refused(
    rewrite(bytes, (body) => {
      body.memo = "different";
    }),
    "all node variants contain the same intent",
  );
});

test("refuses malformed encodings and unsupported transaction wrappers", async () => {
  await refused("", "transaction bytes are canonical nonempty base64");
  await refused("???", "transaction bytes are canonical nonempty base64");
  await refused("/w==", "transaction or policy input is malformed");
  const bytes = await fixture();
  const list = proto.TransactionList.decode(Buffer.from(bytes, "base64"));
  list.transactionList[0].bodyBytes = new Uint8Array([1]);
  await refused(
    Buffer.from(proto.TransactionList.encode(list).finish()).toString("base64"),
    "transaction wrapper contains only signed bytes",
  );
});

test("HTS mandate requires its token and retains custom-fee refusal without TokenInfo", async () => {
  const value = envelope({
    ...mandate,
    schemaVersion: "2",
    asset: { kind: "hts", tokenId: "0.0.123" },
  });
  const bytes = await fixture();
  await refused(bytes, "asset matches the mandate token", context, value);
  const transfer = new TransferTransaction()
    .addTokenTransfer("0.0.123", "0.0.1001", -100)
    .addTokenTransfer("0.0.123", "0.0.1002", 100)
    .setTransactionId(TransactionId.fromString("0.0.4001@1788509000.000000000"))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .setMaxTransactionFee(Hbar.fromTinybars(context.protocolMaxFeeTinybars))
    .freeze();
  await transfer.sign(agent);
  const tokens = Buffer.from(transfer.toBytes()).toString("base64");
  await refused(tokens, "HTS TokenInfo lookup is available", context, value);
  await refused(tokens, "asset matches the HBAR mandate");
});

test("countersigning requires an approval and its configured guard key", async () => {
  const result = await validateCountersignTransfer(
    await fixture(),
    envelope(),
    context,
  );
  assert.ok(result.approved, JSON.stringify(result));
  assert.throws(
    () => countersignTransfer(result, owner),
    /configured guard key/,
  );
  assert.throws(
    () => countersignTransfer({ approved: true } as CountersignApproval, guard),
    /requires an approval/,
  );
});

const tokenId = "0.0.429274";
const tokenEnvelope = envelope({
  ...mandate,
  schemaVersion: "2",
  asset: { kind: "hts", tokenId },
});

function tokenInfo(fields: proto.ITokenInfo = {}): TokenInfo {
  return TokenInfo.fromBytes(
    proto.TokenInfo.encode({
      tokenId: TokenId.fromString(tokenId)._toProtobuf(),
      symbol: "USDC",
      decimals: 6,
      totalSupply: Hbar.fromTinybars(1000000).toTinybars(),
      adminKey: { ed25519: owner.publicKey.toBytesRaw() },
      ...fields,
    }).finish(),
  );
}

async function tokenFixture(nodes = ["0.0.3"]) {
  const transaction = new TransferTransaction()
    .addTokenTransfer(tokenId, "0.0.1001", -100)
    .addTokenTransfer(tokenId, "0.0.1002", 100)
    .setTransactionId(TransactionId.fromString("0.0.4001@1788509000.000000000"))
    .setNodeAccountIds(nodes.map((node) => AccountId.fromString(node)))
    .setMaxTransactionFee(Hbar.fromTinybars(context.protocolMaxFeeTinybars))
    .freeze();
  await transaction.sign(agent);
  return Buffer.from(transaction.toBytes()).toString("base64");
}

const tokenContext: CountersignContext = {
  ...context,
  async executeTokenInfoQuery(query) {
    assert.ok(query instanceof TokenInfoQuery);
    assert.equal(query.tokenId?.toString(), tokenId);
    return tokenInfo();
  },
};

test("approves immutable fee-free USDC at the mandate cap and countersigns exact node bodies", async () => {
  const bytes = await tokenFixture(["0.0.3", "0.0.4"]);
  let reads = 0;
  const approval = await validateCountersignTransfer(bytes, tokenEnvelope, {
    ...tokenContext,
    async executeTokenInfoQuery(query) {
      reads++;
      return tokenContext.executeTokenInfoQuery!(query);
    },
  });
  assert.ok(approval.approved, JSON.stringify(approval));
  assert.equal(reads, 1);
  assert.deepEqual(approval.asset, { kind: "hts", tokenId });
  assert.ok(Object.isFrozen(approval.asset));
  assert.equal(approval.amountTinybars, "100");
  assert.equal(approval.recipientAccountId, "0.0.1002");
  const output = countersignTransfer(approval, guard);
  const before = proto.TransactionList.decode(Buffer.from(bytes, "base64"));
  const after = proto.TransactionList.decode(Buffer.from(output, "base64"));
  assert.equal(after.transactionList.length, before.transactionList.length);
  for (const [index, entry] of after.transactionList.entries()) {
    const original = proto.SignedTransaction.decode(
      before.transactionList[index].signedTransactionBytes!,
    );
    const signed = proto.SignedTransaction.decode(
      entry.signedTransactionBytes!,
    );
    assert.deepEqual(signed.bodyBytes, original.bodyBytes);
    assert.deepEqual(signed.sigMap!.sigPair![0], original.sigMap!.sigPair![0]);
    assert.equal(signed.sigMap!.sigPair!.length, 2);
    assert.ok(
      agent.publicKey.verify(
        signed.bodyBytes,
        signed.sigMap!.sigPair![0].ed25519!,
      ),
    );
    assert.ok(
      guard.publicKey.verify(
        signed.bodyBytes,
        signed.sigMap!.sigPair![1].ed25519!,
      ),
    );
  }
});

for (const [name, fields, invariant] of [
  [
    "fixed custom fee",
    {
      customFees: [{ fixedFee: { amount: Hbar.fromTinybars(1).toTinybars() } }],
    },
    "HTS custom fee list is empty",
  ],
  [
    "fractional custom fee",
    {
      customFees: [
        {
          fractionalFee: {
            fractionalAmount: {
              numerator: Hbar.fromTinybars(1).toTinybars(),
              denominator: Hbar.fromTinybars(100).toTinybars(),
            },
          },
        },
      ],
    },
    "HTS custom fee list is empty",
  ],
  [
    "fee-schedule key",
    { feeScheduleKey: { ed25519: owner.publicKey.toBytesRaw() } },
    "HTS fee schedule is immutable",
  ],
  [
    "wrong returned token ID",
    { tokenId: TokenId.fromString("0.0.123")._toProtobuf() },
    "HTS TokenInfo matches the mandate token",
  ],
] satisfies [string, proto.ITokenInfo, string][]) {
  test(`refuses USDC with ${name}`, async () => {
    await refused(
      await tokenFixture(),
      invariant,
      {
        ...context,
        executeTokenInfoQuery: async () => tokenInfo(fields),
      },
      tokenEnvelope,
    );
  });
}

test("refuses USDC when the TokenInfo query fails", async () => {
  await refused(
    await tokenFixture(),
    "HTS TokenInfo lookup succeeds",
    {
      ...context,
      executeTokenInfoQuery: async () => {
        throw new Error("consensus unavailable");
      },
    },
    tokenEnvelope,
  );
});

test("reads token fee state again for each review", async () => {
  const bytes = await tokenFixture();
  let reads = 0;
  const policy = {
    ...context,
    executeTokenInfoQuery: async () => {
      reads++;
      return tokenInfo(
        reads === 1
          ? {}
          : { feeScheduleKey: { ed25519: owner.publicKey.toBytesRaw() } },
      );
    },
  };
  assert.ok(
    (await validateCountersignTransfer(bytes, tokenEnvelope, policy)).approved,
  );
  await refused(bytes, "HTS fee schedule is immutable", policy, tokenEnvelope);
  assert.equal(reads, 2);
});

test("HBAR review does not query TokenInfo", async () => {
  let reads = 0;
  const result = await validateCountersignTransfer(
    await fixture(),
    envelope(),
    {
      ...context,
      executeTokenInfoQuery: async () => {
        reads++;
        return tokenInfo();
      },
    },
  );
  assert.ok(result.approved);
  assert.equal(reads, 0);
});

const tokenCases: [string, (body: proto.TransactionBody) => void, string][] = [
  [
    "wrong token ID",
    (body) => {
      body.cryptoTransfer!.tokenTransfers![0].token =
        TokenId.fromString("0.0.123")._toProtobuf();
    },
    "asset matches the mandate token",
  ],
  [
    "extra token list",
    (body) => {
      body.cryptoTransfer!.tokenTransfers!.push(
        body.cryptoTransfer!.tokenTransfers![0],
      );
    },
    "asset matches the mandate token",
  ],
  [
    "HBAR movement",
    (body) => {
      body.cryptoTransfer!.transfers = {
        accountAmounts: body.cryptoTransfer!.tokenTransfers![0].transfers,
      };
    },
    "asset matches the mandate token",
  ],
  [
    "NFT",
    (body) => {
      body.cryptoTransfer!.tokenTransfers![0].nftTransfers = [{}];
    },
    "token transfer contains no NFTs or unreviewed fields",
  ],
  [
    "extra token field",
    (body) => {
      body.cryptoTransfer!.tokenTransfers![0].expectedDecimals = { value: 6 };
    },
    "token transfer contains no NFTs or unreviewed fields",
  ],
  [
    "maxCustomFees",
    (body) => {
      body.maxCustomFees = [{}];
    },
    "transaction is only a TransferTransaction with reviewed fields",
  ],
];
for (const [name, edit, invariant] of bodyCases.filter(([name]) =>
  [
    "wrong debit account",
    "extra recipient",
    "unequal amounts",
    "nonpositive recipient",
    "unlisted recipient",
    "alias",
  ].includes(name),
)) {
  tokenCases.push([
    name,
    (body) => {
      body.cryptoTransfer!.transfers = {
        accountAmounts: body.cryptoTransfer!.tokenTransfers![0].transfers,
      };
      edit(body);
      body.cryptoTransfer!.transfers = null;
    },
    invariant,
  ]);
}
for (const index of [0, 1]) {
  for (const field of [
    "isApproval",
    "preTxAllowanceHook",
    "prePostTxAllowanceHook",
  ] as const) {
    tokenCases.push([
      `${field} on adjustment ${index}`,
      (body) => {
        const adjustment =
          body.cryptoTransfer!.tokenTransfers![0].transfers![index];
        if (field === "isApproval") adjustment[field] = true;
        else adjustment[field] = {};
      },
      "balance adjustment contains no approval, hook or unreviewed fields",
    ]);
  }
}
for (const [name, edit, invariant] of tokenCases) {
  test(`refuses USDC ${name} before querying TokenInfo`, async () => {
    let reads = 0;
    await refused(
      rewrite(await tokenFixture(), edit),
      invariant,
      {
        ...context,
        executeTokenInfoQuery: async () => {
          reads++;
          return tokenInfo();
        },
      },
      tokenEnvelope,
    );
    assert.equal(reads, 0);
  });
}

test("refuses USDC over the mandate cap", async () => {
  await refused(
    await tokenFixture(),
    "transfer amount is within the mandate cap",
    tokenContext,
    envelope({ ...tokenEnvelope.mandate, maxAmountTinybars: "99" }),
  );
});

test("USDC retains signed-body re-encode equality for unknown token fields", async () => {
  const bytes = rewrite(await tokenFixture(), (body) => {
    const token = Buffer.concat([
      proto.TokenTransferList.encode(
        body.cryptoTransfer!.tokenTransfers![0],
      ).finish(),
      Buffer.from([0xf8, 0x7f, 0x01]),
    ]);
    const transfer = proto.CryptoTransferTransactionBody.encode({})
      .uint32(2 * 8 + 2)
      .bytes(token)
      .finish();
    body.cryptoTransfer = null;
    return proto.TransactionBody.encode(body)
      .uint32(14 * 8 + 2)
      .bytes(transfer)
      .finish();
  });
  await refused(
    bytes,
    "signed body re-encode equality",
    tokenContext,
    tokenEnvelope,
  );
});

test("invalid USDC agent signature is refused before querying TokenInfo", async () => {
  let reads = 0;
  await refused(
    rewrite(
      await tokenFixture(),
      (body) => {
        body.memo = "changed";
      },
      false,
    ),
    "agent signature verifies the exact signed body bytes",
    {
      ...context,
      executeTokenInfoQuery: async () => {
        reads++;
        return tokenInfo();
      },
    },
    tokenEnvelope,
  );
  assert.equal(reads, 0);
});
