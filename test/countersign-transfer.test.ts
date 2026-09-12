import assert from "node:assert/strict";
import test from "node:test";

import { proto } from "@hiero-ledger/proto";
import {
  AccountId,
  Hbar,
  PrivateKey,
  Transaction,
  TransactionId,
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
    .setTransactionId(TransactionId.fromString("0.0.1001@1788509000.000000000"))
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

function refused(
  bytes: string,
  invariant: string,
  policy = context,
  value = envelope(),
) {
  const checks: ReviewCheck[] = [];
  const result = validateCountersignTransfer(bytes, value, policy, (check) =>
    checks.push(check),
  );
  assert.deepEqual(result, { approved: false, reason: invariant, invariant });
  assert.deepEqual(checks.at(-1), { invariant, passed: false });
}

test("approves SDK-frozen agent-signed HBAR at the cap and preserves exact bytes when countersigning", async () => {
  const bytes = await fixture();
  const result = validateCountersignTransfer(bytes, envelope(), context);
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
  refused(output, "guard signature is not already present");
});

test("re-encode equality refuses an unknown signed body field even with a valid agent signature", async () => {
  const bytes = rewrite(await fixture(), (body) =>
    Buffer.concat([
      proto.TransactionBody.encode(body).finish(),
      Buffer.from([0xf8, 0x7f, 0x01]),
    ]),
  );
  refused(bytes, "signed body re-encode equality");
});

// The outermost envelope is checked too: a field the TransactionList schema does not model
// would otherwise be dropped by the decoder and never reach the inner checks.
test("re-encode equality refuses an unknown TransactionList field", async () => {
  const valid = Buffer.from(await fixture(), "base64");
  const bytes = Buffer.concat([valid, Buffer.from([0xf8, 0x7f, 0x01])]).toString(
    "base64",
  );
  refused(bytes, "transaction list re-encode equality");
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
  refused(bytes, "signed body re-encode equality");
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
    "wrong payer",
    (body) => {
      body.transactionID!.accountID = { ...body.nodeAccountID };
    },
    "transaction ID is an ordinary treasury-paid transaction",
  ],
  [
    "scheduled flag",
    (body) => {
      body.transactionID!.scheduled = true;
    },
    "transaction ID is an ordinary treasury-paid transaction",
  ],
  [
    "nonce",
    (body) => {
      body.transactionID!.nonce = 1;
    },
    "transaction ID is an ordinary treasury-paid transaction",
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
    refused(rewrite(await fixture(), edit), invariant));
}

test("refuses transfers above the owner-signed cap", async () => {
  refused(
    await fixture(),
    "transfer amount is within the mandate cap",
    context,
    envelope({ ...mandate, maxAmountTinybars: "99" }),
  );
});

test("requires the configured owner's signature and matching treasury", async () => {
  refused(
    await fixture(),
    "mandate signature is valid for the configured owner",
    { ...context, ownerPublicKey: guard.publicKey },
  );
  refused(
    await fixture(),
    "mandate treasury matches the configured treasury",
    context,
    envelope({ ...mandate, treasuryAccountId: "0.0.9999" }),
  );
});

test("refuses inactive and expired mandates", async () => {
  for (const nowEpochSeconds of ["1788508799", mandate.expiresAtEpochSeconds]) {
    refused(await fixture(), "mandate is active at review time", {
      ...context,
      nowEpochSeconds,
    });
  }
});

test("default validity floor leaves headroom and refuses its boundary, expiry and future start", async () => {
  const bytes = await fixture();
  for (const nowEpochSeconds of ["1788509090", "1788509120", "1788508999"]) {
    refused(
      bytes,
      "transaction has started and remaining validity exceeds the floor",
      { ...context, nowEpochSeconds },
    );
  }
  assert.ok(
    validateCountersignTransfer(bytes, envelope(), {
      ...context,
      nowEpochSeconds: "1788509089",
    }).approved,
  );
  refused(
    bytes,
    "transaction has started and remaining validity exceeds the floor",
    { ...context, minRemainingValiditySeconds: "115" },
  );
  assert.ok(
    validateCountersignTransfer(bytes, envelope(), {
      ...context,
      minRemainingValiditySeconds: "114",
    }).approved,
  );
  for (const minRemainingValiditySeconds of ["0", "-1", "NaN"]) {
    refused(
      bytes,
      "review time, validity floor and fee policy are valid integers",
      { ...context, minRemainingValiditySeconds },
    );
  }
});

test("refuses absent, wrong, truncated-prefix and invalid agent signatures", async () => {
  const bytes = await fixture();
  refused(
    await fixture(owner),
    "only the configured agent signature is present",
  );
  refused(
    rewrite(
      bytes,
      (_body, signed) => {
        signed.sigMap!.sigPair = [];
      },
      false,
    ),
    "only the configured agent signature is present",
  );
  refused(
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
  refused(
    rewrite(
      bytes,
      (_body, signed) => {
        signed.sigMap!.sigPair![0].ed25519 = new Uint8Array(64);
      },
      false,
    ),
    "agent signature verifies the exact signed body bytes",
  );
  refused(
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
  const result = validateCountersignTransfer(
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
  const result = validateCountersignTransfer(bytes, envelope(), context);
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
  refused(
    rewrite(bytes, (body) => {
      body.memo = "different";
    }),
    "all node variants contain the same intent",
  );
});

test("refuses malformed encodings and unsupported transaction wrappers", async () => {
  refused("", "transaction bytes are canonical nonempty base64");
  refused("???", "transaction bytes are canonical nonempty base64");
  refused("/w==", "transaction or policy input is malformed");
  const bytes = await fixture();
  const list = proto.TransactionList.decode(Buffer.from(bytes, "base64"));
  list.transactionList[0].bodyBytes = new Uint8Array([1]);
  refused(
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
  refused(bytes, "asset matches the mandate token", context, value);
  const transfer = new TransferTransaction()
    .addTokenTransfer("0.0.123", "0.0.1001", -100)
    .addTokenTransfer("0.0.123", "0.0.1002", 100)
    .setTransactionId(TransactionId.fromString("0.0.1001@1788509000.000000000"))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .setMaxTransactionFee(Hbar.fromTinybars(context.protocolMaxFeeTinybars))
    .freeze();
  await transfer.sign(agent);
  const tokens = Buffer.from(transfer.toBytes()).toString("base64");
  refused(
    tokens,
    "HTS custom-fee state is verified as empty and immutable",
    context,
    value,
  );
  refused(tokens, "asset matches the HBAR mandate");
});

test("countersigning requires an approval and its configured guard key", async () => {
  const result = validateCountersignTransfer(
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
