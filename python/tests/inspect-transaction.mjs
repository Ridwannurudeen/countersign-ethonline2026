import { readFileSync } from "node:fs";

import { Transaction } from "@hiero-ledger/sdk";
import { inspectHederaTransaction } from "@x402/hedera";

const { transaction } = JSON.parse(readFileSync(0, "utf8"));
const inspected = inspectHederaTransaction(transaction);
const signerKeys = Transaction.fromBytes(Buffer.from(transaction, "base64"))
  .getSignatures()
  .getFlatSignatureList()
  .flatMap((signatures) => [...signatures.keys()])
  .map((key) => key.toStringRaw());

process.stdout.write(JSON.stringify({ ...inspected, signerKeys }));
