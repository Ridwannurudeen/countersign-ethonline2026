import { proto } from "@hiero-ledger/proto";

export interface CountersignMeterConfig {
  readonly baseTinybars: string;
  readonly perKilobyteTinybars: string;
  readonly perAdjustmentTinybars: string;
  readonly minTinybars: string;
  readonly maxTinybars: string;
}

export const DEFAULT_COUNTERSIGN_METER: Readonly<CountersignMeterConfig> = Object.freeze({
  baseTinybars: "1000000",
  perKilobyteTinybars: "102400",
  perAdjustmentTinybars: "10000",
  minTinybars: "1000000",
  maxTinybars: "10000000",
});

export function validateCountersignMeter(config: CountersignMeterConfig): void {
  for (const field of ["baseTinybars", "perKilobyteTinybars", "perAdjustmentTinybars", "minTinybars", "maxTinybars"] as const) {
    const value = config[field];
    if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
      throw new Error(`countersign meter ${field} must be a positive canonical int64 string`);
    }
  }
  if (BigInt(config.minTinybars) > BigInt(config.maxTinybars)) {
    throw new Error("countersign meter minimum must not exceed maximum");
  }
}

export function quoteCountersign(
  transactionBase64: string,
  config: CountersignMeterConfig = DEFAULT_COUNTERSIGN_METER,
) {
  validateCountersignMeter(config);
  // The HTTP body already has a 16 KiB limit; also bound direct callers before decoding.
  if (transactionBase64.length > 16 * 1024) {
    throw new Error("countersign meter input exceeds the size limit");
  }
  const bytes = Buffer.from(transactionBase64, "base64");
  let transferAdjustments = 0;
  let decodeStatus: "decoded" | "invalid" = "invalid";
  if (bytes.length > 0 && bytes.toString("base64") === transactionBase64) {
    try {
      const list = proto.TransactionList.decode(bytes);
      if (list.transactionList.length === 0) throw new Error("empty transaction list");
      for (const transaction of list.transactionList) {
        if (!transaction.signedTransactionBytes?.length) throw new Error("missing signed bytes");
        const signed = proto.SignedTransaction.decode(transaction.signedTransactionBytes);
        if (signed.bodyBytes.length === 0) throw new Error("missing body bytes");
        const body = proto.TransactionBody.decode(signed.bodyBytes);
        const transfer = body.cryptoTransfer;
        transferAdjustments += transfer?.transfers?.accountAmounts?.length ?? 0;
        for (const token of transfer?.tokenTransfers ?? []) {
          transferAdjustments += (token.transfers?.length ?? 0) + (token.nftTransfers?.length ?? 0);
        }
      }
      decodeStatus = "decoded";
    } catch {
      // Preserve paid policy refusals for malformed transactions. No adjustment count is claimed.
      transferAdjustments = 0;
    }
  }
  const byteCharge = (BigInt(bytes.length) * BigInt(config.perKilobyteTinybars) + 1023n) / 1024n;
  const adjustmentCharge = BigInt(transferAdjustments) * BigInt(config.perAdjustmentTinybars);
  const subtotal = BigInt(config.baseTinybars) + byteCharge + adjustmentCharge;
  const floor = BigInt(config.minTinybars);
  const ceiling = BigInt(config.maxTinybars);
  const amount = subtotal < floor ? floor : subtotal > ceiling ? ceiling : subtotal;
  return {
    version: "countersign-v1" as const,
    decodedBytes: bytes.length,
    transferAdjustments,
    decodeStatus,
    bytesPerKilobyte: 1024,
    ...config,
    byteChargeTinybars: byteCharge.toString(),
    adjustmentChargeTinybars: adjustmentCharge.toString(),
    subtotalTinybars: subtotal.toString(),
    amountTinybars: amount.toString(),
  };
}
