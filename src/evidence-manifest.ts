import { accountMirrorNodeUrl, scheduleMirrorNodeUrl } from "./evidence-links.ts";
import type { MandateAsset } from "./mandate.ts";

export type EvidenceOrigin = "operator" | "external";
export type ReviewEvidenceOutcome = "approved" | "refused";
export type SetupPurpose = "account creation" | "funding" | "token association";

export interface EvidenceMandatePolicy {
  readonly asset: MandateAsset;
  readonly recipientAllowlist: readonly string[];
  readonly maxAmountTinybars: string;
  readonly validFromEpochSeconds: string;
  readonly expiresAtEpochSeconds: string;
}

export interface ReviewEvidenceInput {
  readonly kind: "review";
  readonly origin: EvidenceOrigin;
  readonly scheduleId: string;
  readonly outcome: ReviewEvidenceOutcome;
  readonly decidingInvariant: string;
  readonly mandateDigest: string;
  readonly mandatePolicy: EvidenceMandatePolicy;
  readonly settlementId: string | null;
  readonly settlementAmountTinybars: string | null;
  readonly paymentPayerAccountId: string;
}

export interface SetupEvidenceInput {
  readonly kind: "setup";
  readonly origin: EvidenceOrigin;
  readonly transactionId: string;
  readonly purpose: SetupPurpose;
}

export type EvidenceEvent = ReviewEvidenceInput | SetupEvidenceInput;

export interface ReviewEvidenceRecord extends ReviewEvidenceInput {
  readonly mirrorNodeUrl: string;
  readonly paymentPayerMirrorNodeUrl: string;
}

export interface EvidenceCounts {
  readonly external: {
    readonly reviewCount: number;
    readonly approvalCount: number;
    readonly refusalCount: number;
    readonly distinctPayerAccountCount: number;
  };
  readonly operator: {
    readonly reviewCount: number;
    readonly approvalCount: number;
    readonly refusalCount: number;
  };
}

export interface EvidenceManifest {
  readonly schemaVersion: "1";
  readonly guardPublicKeyPrefix: string;
  readonly records: readonly ReviewEvidenceRecord[];
  readonly setupTransactions: readonly SetupEvidenceInput[];
  readonly counts: EvidenceCounts;
}

const numericEntityIdPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const minimalUnsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;
const digestPattern = /^[0-9a-f]{64}$/;
const publicKeyPrefixPattern = /^(?:[0-9a-f]{2})+$/;
const transactionIdPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)@(0|[1-9][0-9]*)\.[0-9]{9}$/;

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  name: string,
): void {
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`unknown ${name} field: ${field}`);
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`missing ${name} field: ${field}`);
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireOrigin(value: unknown): EvidenceOrigin {
  if (value !== "operator" && value !== "external") {
    throw new Error("origin must be operator or external");
  }
  return value;
}

function requireEntityId(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!numericEntityIdPattern.test(text)) {
    throw new Error(`${field} must be a canonical numeric Hedera ID`);
  }
  return text;
}

function requireDecimal(
  value: unknown,
  field: string,
  positive = false,
): string {
  const text = requireString(value, field);
  if (!minimalUnsignedDecimalPattern.test(text) || (positive && text === "0")) {
    throw new Error(`${field} must be a ${positive ? "positive " : ""}minimal unsigned decimal`);
  }
  return text;
}

function parseAsset(value: unknown): MandateAsset {
  const asset = requireRecord(value, "mandatePolicy.asset");
  if (asset.kind === "hbar") {
    requireExactFields(asset, ["kind"], "mandatePolicy.asset");
    return { kind: "hbar" };
  }
  if (asset.kind === "hts") {
    requireExactFields(asset, ["kind", "tokenId"], "mandatePolicy.asset");
    return {
      kind: "hts",
      tokenId: requireEntityId(asset.tokenId, "mandatePolicy.asset.tokenId"),
    };
  }
  throw new Error("mandatePolicy.asset.kind must be hbar or hts");
}

function parseMandatePolicy(value: unknown): EvidenceMandatePolicy {
  const policy = requireRecord(value, "mandatePolicy");
  requireExactFields(
    policy,
    [
      "asset",
      "recipientAllowlist",
      "maxAmountTinybars",
      "validFromEpochSeconds",
      "expiresAtEpochSeconds",
    ],
    "mandatePolicy",
  );
  if (!Array.isArray(policy.recipientAllowlist) || policy.recipientAllowlist.length === 0) {
    throw new Error("mandatePolicy.recipientAllowlist must contain an account");
  }
  const recipientAllowlist = policy.recipientAllowlist
    .map((accountId) =>
      requireEntityId(accountId, "mandatePolicy.recipientAllowlist entry"),
    )
    .sort();
  if (new Set(recipientAllowlist).size !== recipientAllowlist.length) {
    throw new Error("mandatePolicy.recipientAllowlist contains a duplicate account");
  }
  const validFromEpochSeconds = requireDecimal(
    policy.validFromEpochSeconds,
    "mandatePolicy.validFromEpochSeconds",
  );
  const expiresAtEpochSeconds = requireDecimal(
    policy.expiresAtEpochSeconds,
    "mandatePolicy.expiresAtEpochSeconds",
  );
  if (BigInt(expiresAtEpochSeconds) <= BigInt(validFromEpochSeconds)) {
    throw new Error("mandatePolicy validity interval must have positive duration");
  }
  return {
    asset: parseAsset(policy.asset),
    recipientAllowlist,
    maxAmountTinybars: requireDecimal(
      policy.maxAmountTinybars,
      "mandatePolicy.maxAmountTinybars",
      true,
    ),
    validFromEpochSeconds,
    expiresAtEpochSeconds,
  };
}

function parseReviewInput(value: unknown): ReviewEvidenceInput {
  const record = requireRecord(value, "review record");
  const origin = requireOrigin(record.origin);
  requireExactFields(
    record,
    [
      "kind",
      "origin",
      "scheduleId",
      "outcome",
      "decidingInvariant",
      "mandateDigest",
      "mandatePolicy",
      "settlementId",
      "settlementAmountTinybars",
      "paymentPayerAccountId",
    ],
    "review record",
  );
  if (record.kind !== "review") {
    throw new Error("review record kind must be review");
  }
  if (record.outcome !== "approved" && record.outcome !== "refused") {
    throw new Error("review outcome must be approved or refused");
  }
  const mandateDigest = requireString(record.mandateDigest, "mandateDigest");
  if (!digestPattern.test(mandateDigest)) {
    throw new Error("mandateDigest must be 64 lowercase hexadecimal characters");
  }
  const settlementId = record.settlementId;
  const settlementAmountTinybars = record.settlementAmountTinybars;
  if (
    (settlementId === null) !== (settlementAmountTinybars === null) ||
    (settlementId !== null &&
      (typeof settlementId !== "string" || !transactionIdPattern.test(settlementId)))
  ) {
    throw new Error("settlementId and settlementAmountTinybars must identify one settlement");
  }
  return {
    kind: "review",
    origin,
    scheduleId: requireEntityId(record.scheduleId, "scheduleId"),
    outcome: record.outcome,
    decidingInvariant: requireString(
      record.decidingInvariant,
      "decidingInvariant",
    ),
    mandateDigest,
    mandatePolicy: parseMandatePolicy(record.mandatePolicy),
    settlementId,
    settlementAmountTinybars:
      settlementAmountTinybars === null
        ? null
        : requireDecimal(
            settlementAmountTinybars,
            "settlementAmountTinybars",
            true,
          ),
    paymentPayerAccountId: requireEntityId(
      record.paymentPayerAccountId,
      "paymentPayerAccountId",
    ),
  };
}

function parseSetupInput(value: unknown): SetupEvidenceInput {
  const record = requireRecord(value, "setup transaction");
  const origin = requireOrigin(record.origin);
  requireExactFields(
    record,
    ["kind", "origin", "transactionId", "purpose"],
    "setup transaction",
  );
  if (record.kind !== "setup") {
    throw new Error("setup transaction kind must be setup");
  }
  if (
    record.purpose !== "account creation" &&
    record.purpose !== "funding" &&
    record.purpose !== "token association"
  ) {
    throw new Error("setup transaction purpose is not recognized");
  }
  const transactionId = requireString(record.transactionId, "transactionId");
  if (!transactionIdPattern.test(transactionId)) {
    throw new Error("transactionId must be a canonical Hedera transaction ID");
  }
  return {
    kind: "setup",
    origin,
    transactionId,
    purpose: record.purpose,
  };
}

function requireCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseCounts(value: unknown): EvidenceCounts {
  const counts = requireRecord(value, "counts");
  requireExactFields(counts, ["external", "operator"], "counts");
  const external = requireRecord(counts.external, "counts.external");
  requireExactFields(
    external,
    [
      "reviewCount",
      "approvalCount",
      "refusalCount",
      "distinctPayerAccountCount",
    ],
    "counts.external",
  );
  const operator = requireRecord(counts.operator, "counts.operator");
  requireExactFields(
    operator,
    ["reviewCount", "approvalCount", "refusalCount"],
    "counts.operator",
  );
  return {
    external: {
      reviewCount: requireCount(
        external.reviewCount,
        "counts.external.reviewCount",
      ),
      approvalCount: requireCount(
        external.approvalCount,
        "counts.external.approvalCount",
      ),
      refusalCount: requireCount(
        external.refusalCount,
        "counts.external.refusalCount",
      ),
      distinctPayerAccountCount: requireCount(
        external.distinctPayerAccountCount,
        "counts.external.distinctPayerAccountCount",
      ),
    },
    operator: {
      reviewCount: requireCount(
        operator.reviewCount,
        "counts.operator.reviewCount",
      ),
      approvalCount: requireCount(
        operator.approvalCount,
        "counts.operator.approvalCount",
      ),
      refusalCount: requireCount(
        operator.refusalCount,
        "counts.operator.refusalCount",
      ),
    },
  };
}

function separatedCounts(records: readonly ReviewEvidenceRecord[]): EvidenceCounts {
  const external = records.filter((record) => record.origin === "external");
  const operator = records.filter((record) => record.origin === "operator");
  return {
    external: {
      reviewCount: external.length,
      approvalCount: external.filter((record) => record.outcome === "approved").length,
      refusalCount: external.filter((record) => record.outcome === "refused").length,
      distinctPayerAccountCount: new Set(
        external.map((record) => record.paymentPayerAccountId),
      ).size,
    },
    operator: {
      reviewCount: operator.length,
      approvalCount: operator.filter((record) => record.outcome === "approved").length,
      refusalCount: operator.filter((record) => record.outcome === "refused").length,
    },
  };
}

export function buildEvidenceManifest(
  guardPublicKeyPrefix: string,
  events: readonly EvidenceEvent[],
): EvidenceManifest {
  const records: ReviewEvidenceRecord[] = [];
  const setupTransactions: SetupEvidenceInput[] = [];
  for (const event of events) {
    if (requireRecord(event, "evidence event").kind === "review") {
      const review = parseReviewInput(event);
      records.push({
        ...review,
        mirrorNodeUrl: scheduleMirrorNodeUrl(review.scheduleId),
        paymentPayerMirrorNodeUrl: accountMirrorNodeUrl(
          review.paymentPayerAccountId,
        ),
      });
    } else {
      setupTransactions.push(parseSetupInput(event));
    }
  }
  if (
    guardPublicKeyPrefix !== "" &&
    !publicKeyPrefixPattern.test(guardPublicKeyPrefix)
  ) {
    throw new Error("guardPublicKeyPrefix must be lowercase hexadecimal");
  }
  if (records.length > 0 && guardPublicKeyPrefix === "") {
    throw new Error("guardPublicKeyPrefix is required when reviews are present");
  }
  return {
    schemaVersion: "1",
    guardPublicKeyPrefix,
    records,
    setupTransactions,
    counts: separatedCounts(records),
  };
}

export function parseEvidenceManifest(value: unknown): EvidenceManifest {
  const manifest = requireRecord(value, "evidence manifest");
  requireExactFields(
    manifest,
    [
      "schemaVersion",
      "guardPublicKeyPrefix",
      "records",
      "setupTransactions",
      "counts",
    ],
    "evidence manifest",
  );
  if (manifest.schemaVersion !== "1") {
    throw new Error("evidence manifest schemaVersion must be 1");
  }
  if (!Array.isArray(manifest.records)) {
    throw new TypeError("evidence manifest records must be an array");
  }
  if (!Array.isArray(manifest.setupTransactions)) {
    throw new TypeError("evidence manifest setupTransactions must be an array");
  }
  if (typeof manifest.guardPublicKeyPrefix !== "string") {
    throw new TypeError("guardPublicKeyPrefix must be a string");
  }
  const reviewInputs = manifest.records.map((value) => {
    const record = requireRecord(value, "review record");
    requireExactFields(
      record,
      [
        "kind",
        "origin",
        "scheduleId",
        "outcome",
        "decidingInvariant",
        "mandateDigest",
        "mandatePolicy",
        "settlementId",
        "settlementAmountTinybars",
        "paymentPayerAccountId",
        "mirrorNodeUrl",
        "paymentPayerMirrorNodeUrl",
      ],
      "review record",
    );
    const {
      mirrorNodeUrl,
      paymentPayerMirrorNodeUrl,
      ...input
    } = record;
    const parsed = parseReviewInput(input);
    if (mirrorNodeUrl !== scheduleMirrorNodeUrl(parsed.scheduleId)) {
      throw new Error("mirrorNodeUrl does not match scheduleId");
    }
    if (
      paymentPayerMirrorNodeUrl !==
      accountMirrorNodeUrl(parsed.paymentPayerAccountId)
    ) {
      throw new Error("paymentPayerMirrorNodeUrl does not match paymentPayerAccountId");
    }
    return parsed;
  });
  const setupInputs = manifest.setupTransactions.map(parseSetupInput);
  const suppliedCounts = parseCounts(manifest.counts);
  const rebuilt = buildEvidenceManifest(
    manifest.guardPublicKeyPrefix,
    [...reviewInputs, ...setupInputs],
  );
  if (JSON.stringify(suppliedCounts) !== JSON.stringify(rebuilt.counts)) {
    throw new Error("evidence manifest counts do not match its separated records");
  }
  return rebuilt;
}
