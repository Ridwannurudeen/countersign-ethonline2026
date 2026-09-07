import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PublicKey, Transaction } from "@hiero-ledger/sdk";
import { inspectHederaTransaction } from "@x402/hedera";

const { transaction, expectedPublicKey } = JSON.parse(readFileSync(0, "utf8"));
const inspected = inspectHederaTransaction(transaction);
const decoded = Transaction.fromBytes(Buffer.from(transaction, "base64"));
assert.equal(
  PublicKey.fromStringED25519(expectedPublicKey).verifyTransaction(decoded),
  true,
  "expected payer signature must verify",
);
const signerKeys = decoded
  .getSignatures()
  .getFlatSignatureList()
  .flatMap((signatures) => [...signatures.keys()])
  .map((key) => key.toStringRaw());

process.stdout.write(JSON.stringify({ ...inspected, signerKeys }));
