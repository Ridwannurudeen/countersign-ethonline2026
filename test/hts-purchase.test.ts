import assert from "node:assert/strict";
import test from "node:test";

import { Client, PrivateKey, TokenAssociateTransaction, Transaction, TransferTransaction } from "@hiero-ledger/sdk";

import { assertMirrorTokenTransfer, submit } from "../scripts/hts-purchase.ts";

test("HTS submission preserves the owner signature on an already frozen association", async (t) => {
  const client = Client.forNetwork({ "127.0.0.1:50211": "0.0.3" })
    .setOperator("0.0.1001", PrivateKey.generateED25519());
  try {
    const transaction = await new TokenAssociateTransaction().setAccountId("0.0.1002")
      .setTokenIds(["0.0.2001"]).freezeWith(client).sign(PrivateKey.generateED25519());
    const signedBytes = transaction.toBytes();
    t.mock.method(transaction, "execute", async () => {
      assert.deepEqual(transaction.toBytes(), signedBytes, "submission must preserve frozen bodies and signatures");
      throw new Error("submission intercepted before network execution");
    });
    await assert.rejects(submit(transaction, client, "Offline association"),
      /submission intercepted before network execution/);
  } finally {
    client.close();
  }
});

test("HTS submission preserves deserialized agent and guard signatures", async (t) => {
  const client = Client.forNetwork({ "127.0.0.1:50211": "0.0.3" })
    .setOperator("0.0.1001", PrivateKey.generateED25519());
  try {
    const transfer = new TransferTransaction().addTokenTransfer("0.0.2001", "0.0.1002", -10)
      .addTokenTransfer("0.0.2001", "0.0.1003", 10).freezeWith(client);
    await transfer.sign(PrivateKey.generateED25519());
    await transfer.sign(PrivateKey.generateED25519());
    const signedBytes = transfer.toBytes();
    const transaction = Transaction.fromBytes(signedBytes);
    t.mock.method(transaction, "execute", async () => {
      assert.deepEqual(transaction.toBytes(), signedBytes);
      throw new Error("submission intercepted before network execution");
    });
    await assert.rejects(submit(transaction, client, "Offline HTS transfer"),
      /submission intercepted before network execution/);
  } finally {
    client.close();
  }
});

const id = "0.0.1001@1789298656.658027046";
const mirrorTransfer = {
  transactions: [{
    transaction_id: "0.0.1001-1789298656-658027046", result: "SUCCESS",
    token_transfers: [
      { token_id: "0.0.2001", account: "0.0.1002", amount: -10 },
      { token_id: "0.0.2001", account: "0.0.1003", amount: 10 },
    ],
  }],
};

test("HTS mirror verification accepts exact token adjustments without an optional assessed-fees field", () => {
  assertMirrorTokenTransfer(mirrorTransfer, id, "0.0.2001", "0.0.1002", "0.0.1003", "10");
});

test("HTS mirror verification rejects failed, unrelated, misdirected and inexact records", () => {
  for (const change of [
    { result: "INVALID_SIGNATURE" },
    { transaction_id: "0.0.1001-1789298656-658027047" },
    { assessed_custom_fees: [{ amount: 1 }] },
    { token_transfers: mirrorTransfer.transactions[0].token_transfers.map((entry) => ({ ...entry, token_id: "0.0.2002" })) },
    { token_transfers: [{ token_id: "0.0.2001", account: "0.0.1002", amount: -10 }, { token_id: "0.0.2001", account: "0.0.1004", amount: 10 }] },
    { token_transfers: [{ token_id: "0.0.2001", account: "0.0.1002", amount: -9 }, { token_id: "0.0.2001", account: "0.0.1003", amount: 9 }] },
  ]) {
    assert.throws(() => assertMirrorTokenTransfer({ transactions: [{ ...mirrorTransfer.transactions[0], ...change }] },
      id, "0.0.2001", "0.0.1002", "0.0.1003", "10"));
  }
});
