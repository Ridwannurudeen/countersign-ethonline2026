import { proto } from "@hiero-ledger/proto";
import {
  TokenInfoQuery,
  type TokenInfo,
  type PrivateKey,
  type PublicKey,
} from "@hiero-ledger/sdk";

import {
  mandateAsset,
  parseMandateEnvelope,
  verifyMandateSignature,
  type MandateAsset,
} from "./mandate.ts";
import type { ReviewCheckReporter, ReviewOutcome } from "./review-schedule.ts";

export interface CountersignContext {
  readonly expectedAgentAccountId: string;
  readonly treasuryAccountId: string;
  // These keys must come from trusted configuration for the named accounts.
  readonly ownerPublicKey: PublicKey;
  readonly agentPublicKey: PublicKey;
  readonly guardPublicKey: PublicKey;
  readonly protocolMaxFeeTinybars: string;
  readonly nowEpochSeconds: string;
  readonly minRemainingValiditySeconds?: string;
  executeTokenInfoQuery?(query: TokenInfoQuery): Promise<TokenInfo>;
}

const validated = Symbol("validated transfer bytes");

export type CountersignApproval = Extract<ReviewOutcome, { approved: true }> & {
  readonly treasuryAccountId: string;
  readonly agentAccountId: string;
  readonly asset: Readonly<MandateAsset>;
  readonly [validated]: {
    readonly bytes: string;
    readonly guardPublicKey: string;
  };
};

export type CountersignOutcome =
  | CountersignApproval
  | (Extract<ReviewOutcome, { approved: false }> & {
      readonly invariant: string;
    });

class PolicyRefusal extends Error {}

function onlyFields(value: object, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field));
}

function numericId(
  value: proto.IAccountID | proto.ITokenID | null | undefined,
): string | null {
  if (value == null) return null;
  const field = "accountNum" in value ? "accountNum" : "tokenNum";
  if (!onlyFields(value, ["shardNum", "realmNum", field])) return null;
  const number =
    field === "accountNum"
      ? (value as proto.IAccountID).accountNum
      : (value as proto.ITokenID).tokenNum;
  const parts = [value.shardNum, value.realmNum, number];
  if (
    parts.some(
      (part) => part == null || !/^(0|[1-9][0-9]*)$/.test(part.toString()),
    )
  ) {
    return null;
  }
  return parts.join(".");
}

export async function validateCountersignTransfer(
  transactionBase64: string,
  mandateEnvelope: unknown,
  context: CountersignContext,
  reportCheck?: ReviewCheckReporter,
): Promise<CountersignOutcome> {
  function check(invariant: string, passed: boolean): asserts passed {
    reportCheck?.({ invariant, passed });
    if (!passed) throw new PolicyRefusal(invariant);
  }

  try {
    check(
      "policy account IDs are canonical numeric IDs",
      [context.expectedAgentAccountId, context.treasuryAccountId].every((id) =>
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(id),
      ),
    );
    check(
      "agent and guard keys are distinct supported keys",
      [context.agentPublicKey, context.guardPublicKey].every(
        (key) => key.type === "ED25519" || key.type === "secp256k1",
      ) && !context.agentPublicKey.equals(context.guardPublicKey),
    );
    const envelope = parseMandateEnvelope(mandateEnvelope);
    check(
      "mandate signature is valid for the configured owner",
      verifyMandateSignature(envelope, context.ownerPublicKey),
    );
    const mandate = envelope.mandate;
    const asset = mandateAsset(mandate);
    check(
      "mandate treasury matches the configured treasury",
      mandate.treasuryAccountId === context.treasuryAccountId,
    );
    const floorText = context.minRemainingValiditySeconds ?? "30";
    check(
      "review time, validity floor and fee policy are valid integers",
      [
        context.nowEpochSeconds,
        floorText,
        context.protocolMaxFeeTinybars,
      ].every((value) => /^(0|[1-9][0-9]*)$/.test(value)) &&
        BigInt(floorText) > 0n &&
        BigInt(context.protocolMaxFeeTinybars) > 0n,
    );
    const now = BigInt(context.nowEpochSeconds);
    check(
      "mandate is active at review time",
      now >= BigInt(mandate.validFromEpochSeconds) &&
        now < BigInt(mandate.expiresAtEpochSeconds),
    );

    const bytes = Buffer.from(transactionBase64, "base64");
    check(
      "transaction bytes are canonical nonempty base64",
      bytes.length > 0 && bytes.toString("base64") === transactionBase64,
    );
    const list = proto.TransactionList.decode(bytes);
    check(
      "transaction list re-encode equality",
      Buffer.from(proto.TransactionList.encode(list).finish()).equals(bytes),
    );
    check("transaction list is nonempty", list.transactionList.length > 0);
    let intent:
      | { recipientAccountId: string; amountTinybars: string }
      | undefined;
    let commonBody: Buffer | undefined;
    const nodes = new Set<string>();
    for (const transaction of list.transactionList) {
      check(
        "transaction wrapper contains only signed bytes",
        onlyFields(transaction, ["signedTransactionBytes"]) &&
          transaction.signedTransactionBytes != null &&
          transaction.signedTransactionBytes.length > 0,
      );
      const signed = proto.SignedTransaction.decode(
        transaction.signedTransactionBytes,
      );
      check(
        "signed transaction re-encode equality",
        Buffer.from(proto.SignedTransaction.encode(signed).finish()).equals(
          transaction.signedTransactionBytes,
        ),
      );
      check(
        "signed transaction contains only body bytes and signature map",
        onlyFields(signed, ["bodyBytes", "sigMap"]) &&
          signed.bodyBytes.length > 0,
      );
      const body = proto.TransactionBody.decode(signed.bodyBytes);
      check(
        "signed body re-encode equality",
        Buffer.from(proto.TransactionBody.encode(body).finish()).equals(
          signed.bodyBytes,
        ),
      );
      check(
        "transaction is only a TransferTransaction with reviewed fields",
        body.cryptoTransfer != null &&
          body.maxCustomFees.length === 0 &&
          onlyFields(body, [
            "transactionID",
            "nodeAccountID",
            "transactionFee",
            "transactionValidDuration",
            "memo",
            "cryptoTransfer",
            "maxCustomFees",
          ]),
      );
      const comparable = Buffer.from(
        proto.TransactionBody.encode({ ...body, nodeAccountID: null }).finish(),
      );
      check(
        "all node variants contain the same intent",
        commonBody === undefined || commonBody.equals(comparable),
      );
      commonBody = comparable;
      const node = numericId(body.nodeAccountID);
      check(
        "node account is numeric and unique",
        node !== null && !nodes.has(node),
      );
      nodes.add(node);
      const id = body.transactionID;
      check(
        "transaction ID is an ordinary treasury-paid transaction",
        id != null &&
          onlyFields(id, [
            "accountID",
            "transactionValidStart",
            "scheduled",
            "nonce",
          ]) &&
          !id.scheduled &&
          (id.nonce == null || id.nonce === 0) &&
          numericId(id.accountID) === context.treasuryAccountId,
      );
      check(
        "transaction fee equals the fixed protocol value",
        body.transactionFee.toString() === context.protocolMaxFeeTinybars,
      );
      const start = id.transactionValidStart;
      const duration = body.transactionValidDuration;
      check(
        "transaction validity fields are present and valid",
        start != null &&
          onlyFields(start, ["seconds", "nanos"]) &&
          start.seconds != null &&
          /^(0|[1-9][0-9]*)$/.test(start.seconds.toString()) &&
          Number.isInteger(start.nanos ?? 0) &&
          (start.nanos ?? 0) >= 0 &&
          (start.nanos ?? 0) < 1_000_000_000 &&
          duration != null &&
          onlyFields(duration, ["seconds"]) &&
          duration.seconds != null &&
          /^[1-9][0-9]*$/.test(duration.seconds.toString()),
      );
      const startNanos =
        BigInt(start.seconds.toString()) * 1_000_000_000n +
        BigInt(start.nanos ?? 0);
      const nowNanos = now * 1_000_000_000n;
      check(
        "transaction has started and remaining validity exceeds the floor",
        startNanos <= nowNanos &&
          startNanos +
            BigInt(duration.seconds.toString()) * 1_000_000_000n -
            nowNanos >
            BigInt(floorText) * 1_000_000_000n,
      );

      const transfer = body.cryptoTransfer;
      check(
        "cryptoTransfer contains only reviewed fields",
        onlyFields(transfer, ["transfers", "tokenTransfers"]),
      );
      const tokens = transfer.tokenTransfers ?? [];
      let adjustments: proto.IAccountAmount[];
      if (asset.kind === "hbar") {
        check(
          "asset matches the HBAR mandate",
          tokens.length === 0 && transfer.transfers != null,
        );
        check(
          "HBAR transfer list contains only reviewed fields",
          onlyFields(transfer.transfers, ["accountAmounts"]),
        );
        adjustments = transfer.transfers.accountAmounts ?? [];
      } else {
        check(
          "asset matches the mandate token",
          tokens.length === 1 &&
            numericId(tokens[0].token) === asset.tokenId &&
            (transfer.transfers == null ||
              (onlyFields(transfer.transfers, ["accountAmounts"]) &&
                (transfer.transfers.accountAmounts ?? []).length === 0)),
        );
        check(
          "token transfer contains no NFTs or unreviewed fields",
          onlyFields(tokens[0], ["token", "transfers", "nftTransfers"]) &&
            (tokens[0].nftTransfers ?? []).length === 0,
        );
        adjustments = tokens[0].transfers ?? [];
      }
      check(
        "transfer contains exactly two balance adjustments",
        adjustments.length === 2,
      );
      const parsed = adjustments.map((adjustment) => {
        check(
          "balance adjustment contains no approval, hook or unreviewed fields",
          onlyFields(adjustment, ["accountID", "amount", "isApproval"]) &&
            !adjustment.isApproval,
        );
        const accountId = numericId(adjustment.accountID);
        check(
          "balance adjustment uses a numeric account ID",
          accountId !== null,
        );
        check(
          "balance adjustment amount is a valid integer",
          adjustment.amount != null &&
            /^-?(0|[1-9][0-9]*)$/.test(adjustment.amount.toString()),
        );
        return { accountId, amount: BigInt(adjustment.amount.toString()) };
      });
      const debit = parsed.find(
        ({ accountId }) => accountId === context.treasuryAccountId,
      );
      const credit = parsed.find(
        ({ accountId }) => accountId !== context.treasuryAccountId,
      );
      check(
        "only the treasury is debited and exactly one recipient is credited",
        debit !== undefined &&
          credit !== undefined &&
          debit.amount < 0n &&
          credit.amount > 0n,
      );
      check(
        "treasury debit and recipient credit are equal and opposite",
        -debit.amount === credit.amount,
      );
      check(
        "recipient is on the mandate allowlist",
        mandate.recipientAllowlist.includes(credit.accountId),
      );
      check(
        "transfer amount is within the mandate cap",
        credit.amount <= BigInt(mandate.maxAmountTinybars),
      );
      check(
        "signature map contains only signature pairs",
        signed.sigMap != null && onlyFields(signed.sigMap, ["sigPair"]),
      );
      const pairs = signed.sigMap.sigPair ?? [];
      const agentBytes = Buffer.from(context.agentPublicKey.toBytesRaw());
      const guardBytes = Buffer.from(context.guardPublicKey.toBytesRaw());
      check(
        "guard signature is not already present",
        !pairs.some((pair) => {
          const prefix = pair.pubKeyPrefix;
          return (
            prefix != null &&
            prefix.length <= guardBytes.length &&
            guardBytes.subarray(0, prefix.length).equals(prefix)
          );
        }),
      );
      check(
        "only the configured agent signature is present",
        pairs.length === 1 &&
          pairs[0].pubKeyPrefix != null &&
          agentBytes.equals(pairs[0].pubKeyPrefix),
      );
      const pair = pairs[0];
      const signatureField =
        context.agentPublicKey.type === "ED25519"
          ? "ed25519"
          : "ECDSASecp256k1";
      const signature = pair[signatureField];
      check(
        "agent signature verifies the exact signed body bytes",
        onlyFields(pair, ["pubKeyPrefix", signatureField]) &&
          signature != null &&
          signature.length === 64 &&
          context.agentPublicKey.verify(signed.bodyBytes, signature),
      );
      intent = {
        recipientAccountId: credit.accountId,
        amountTinybars: credit.amount.toString(),
      };
    }
    check("validated intent is present", intent !== undefined);
    if (asset.kind === "hts") {
      check(
        "HTS TokenInfo lookup is available",
        context.executeTokenInfoQuery !== undefined,
      );
      let info: TokenInfo;
      try {
        info = await context.executeTokenInfoQuery(
          new TokenInfoQuery().setTokenId(asset.tokenId),
        );
      } catch {
        check("HTS TokenInfo lookup succeeds", false);
      }
      check(
        "HTS TokenInfo matches the mandate token",
        info.tokenId.toString() === asset.tokenId,
      );
      check("HTS custom fee list is empty", info.customFees.length === 0);
      check("HTS fee schedule is immutable", info.feeScheduleKey === null);
    }
    return Object.freeze({
      approved: true,
      ...intent,
      treasuryAccountId: context.treasuryAccountId,
      agentAccountId: context.expectedAgentAccountId,
      asset: Object.freeze(asset),
      [validated]: Object.freeze({
        bytes: transactionBase64,
        guardPublicKey: context.guardPublicKey.toStringDer(),
      }),
    });
  } catch (error) {
    const invariant =
      error instanceof PolicyRefusal
        ? error.message
        : "transaction or policy input is malformed";
    if (!(error instanceof PolicyRefusal))
      reportCheck?.({ invariant, passed: false });
    return { approved: false, reason: invariant, invariant };
  }
}

export function countersignTransfer(
  approval: CountersignApproval,
  guardKey: PrivateKey,
): string {
  const snapshot = approval[validated];
  if (
    !approval.approved ||
    snapshot == null ||
    guardKey.publicKey.toStringDer() !== snapshot.guardPublicKey
  ) {
    throw new Error(
      "countersigning requires an approval and its configured guard key",
    );
  }
  const list = proto.TransactionList.decode(
    Buffer.from(snapshot.bytes, "base64"),
  );
  for (const transaction of list.transactionList) {
    const signed = proto.SignedTransaction.decode(
      transaction.signedTransactionBytes!,
    );
    signed.sigMap!.sigPair!.push(
      guardKey.publicKey._toProtobufSignature(guardKey.sign(signed.bodyBytes)),
    );
    transaction.signedTransactionBytes =
      proto.SignedTransaction.encode(signed).finish();
  }
  return Buffer.from(proto.TransactionList.encode(list).finish()).toString(
    "base64",
  );
}
